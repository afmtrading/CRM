/**
 * Reading a spreadsheet somebody else made.
 *
 * Every function here is pure, so the preview and the commit run the same code
 * and what you approve is exactly what gets written. That is the same rule
 * csv.ts already states, extended to the parts of a real file that a plain
 * column mapping cannot survive.
 *
 * Everything below was written against one real 257-row buyer list. Where a
 * decision looks arbitrary, the comment says which rows in that file forced it.
 */

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/**
 * RFC 4180, plus the two things every real export gets wrong.
 *
 * A byte-order mark on the first cell, which turns `Priority` into
 * `﻿Priority` and quietly fails an exact-match column mapping. And CRLF
 * line endings, which leave a trailing carriage return on the last cell of
 * every row.
 */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]

    if (quoted) {
      if (character === '"') {
        // A doubled quote inside a quoted cell is one literal quote.
        if (input[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += character
      }
      continue
    }

    if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(cell)
      cell = ''
    } else if (character === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (character !== '\r') {
      cell += character
    }
  }

  // A file that does not end in a newline still has a last row.
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }

  return rows
}

/**
 * Which row holds the column names.
 *
 * Not always the first one. The file this was written for opens with a title,
 * a "cleaned on" note and a dedupe note — three rows of one cell each — and the
 * headers are on row 4. An importer that assumes row 1 produces a single column
 * called "Master Contacts - Consolidated Buyer, Broker, Marketplace and Auction
 * Outreach List", silently, and everything after that is wrong.
 *
 * The header is the first row that fills most of its cells and repeats none of
 * them. A prose row fills one cell; a data row usually has blanks and often
 * repeats a value. Both are things a header cannot do.
 */
export function detectHeaderRow(rows: string[][]): number {
  for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
    const cells = rows[index].map((cell) => cell.trim())
    const filled = cells.filter(Boolean)

    /*
     * Measured against the row's own width rather than the table's. A
     * spreadsheet export pads every row to the same number of cells, so the
     * title row is one value and twenty-two blanks — 4% full — while the header
     * is nearly all of them. Comparing against the widest row in the file would
     * make one unusually long data row raise the bar for everybody.
     */
    if (cells.length < 2 || filled.length < Math.ceil(cells.length * 0.6)) continue

    // A header cannot name the same column twice; a data row often repeats a
    // value across cells.
    if (new Set(filled.map((cell) => cell.toLowerCase())).size !== filled.length) continue

    return index
  }

  return 0
}

/** The header row and the rows under it, with blank rows dropped. */
export function readTable(text: string): { headers: string[]; rows: string[][]; headerRow: number } {
  const all = parseCsv(text)
  const headerRow = detectHeaderRow(all)
  const headers = (all[headerRow] ?? []).map((cell) => cell.trim())
  const rows = all
    .slice(headerRow + 1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))

  return { headers, rows, headerRow }
}

// -----------------------------------------------------------------------------
// Placeholders
// -----------------------------------------------------------------------------

/**
 * Values in a name column that are not names.
 *
 * 154 of 257 rows in the source file have a contact called "Company intake",
 * with the title "Purchasing / inventory intake". It is a sentinel meaning "no
 * named contact — use the company's general channel". Imported literally it
 * creates 154 people who do not exist, and no column mapping catches it,
 * because the column is mapped correctly.
 *
 * The signal is repetition. A real person's name appears once, or twice at a
 * company with two records. A value on a fifth of the file is a stand-in for
 * something, whatever it happens to say.
 *
 * Returns candidates rather than acting on them: this decides what to put in
 * front of somebody, not what to do.
 */
export function detectPlaceholders(
  values: string[],
  { minimumShare = 0.05, minimumCount = 5 }: { minimumShare?: number; minimumCount?: number } = {},
): { value: string; count: number; share: number }[] {
  const filled = values.map((value) => value.trim()).filter(Boolean)
  if (filled.length === 0) return []

  const counts = new Map<string, number>()
  for (const value of filled) counts.set(value, (counts.get(value) ?? 0) + 1)

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, share: count / filled.length }))
    .filter((entry) => entry.count >= minimumCount && entry.share >= minimumShare)
    .sort((a, b) => b.count - a.count)
}

// -----------------------------------------------------------------------------
// Geography
// -----------------------------------------------------------------------------

/**
 * Spellings of a country that ISO does not know about.
 *
 * Only aliases live here. The countries themselves come from the database,
 * which is the authority — keeping a second copy of ISO 3166 in the bundle is
 * how the two drift apart. What the database cannot know is that this business
 * writes "USA" and that a French-language source writes "Ãtats-Unis".
 */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US',
  'u.s.a.': 'US',
  'u.s.': 'US',
  us: 'US',
  america: 'US',
  'united states of america': 'US',
  'etats-unis': 'US',
  'états-unis': 'US',
  uk: 'GB',
  'u.k.': 'GB',
  'great britain': 'GB',
  england: 'GB',
  can: 'CA',
  canada: 'CA',
  mex: 'MX',
  mexique: 'MX',
  deutschland: 'DE',
  espana: 'ES',
  españa: 'ES',
  holland: 'NL',
  'the netherlands': 'NL',
  'south korea': 'KR',
  'north korea': 'KP',
  russia: 'RU',
  vietnam: 'VN',
  uae: 'AE',
}

/**
 * Words that are not countries and never resolve to one.
 *
 * "International" appears on 7 rows of the source file and "Unknown" on 1.
 * Guessing at either would be inventing data; both become blank and a flag.
 */
const NOT_A_COUNTRY = new Set([
  'international',
  'unknown',
  'n/a',
  'na',
  'none',
  'various',
  'worldwide',
  'global',
  'other',
])

export interface CountryLookup {
  /** ISO 3166-1 alpha-2, from the database. */
  code: string
  name: string
}

/** A name, a code or a known alias to a country code. Null when it is none of them. */
export function normaliseCountry(value: string, countries: CountryLookup[]): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const key = trimmed.toLowerCase()
  if (NOT_A_COUNTRY.has(key)) return null

  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase()
    if (countries.some((country) => country.code === upper)) return upper
  }

  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key]

  const byName = countries.find((country) => country.name.toLowerCase() === key)
  return byName?.code ?? null
}

export interface RegionCell {
  /** ISO 3166-2, when the cell named a state or province. */
  region: string | null
  /** The city or area, kept for the address rather than for filtering. */
  locality: string | null
  /** The words after the slash, which described a selling territory. */
  territory: string | null
}

/**
 * Pulls apart a region cell that is carrying two facts.
 *
 * 51 rows of the source file read like this:
 *
 *     QC - Montreal / North America
 *     ON - Niagara / national
 *     BC - Burnaby / national
 *     IL / national
 *
 * Left of the slash is where the company *is*. Right of it is where it
 * *sells*. Somebody kept both in one string because there was nowhere else to
 * put them, which is the entire reason based_in and sells_in now exist.
 *
 * The subdivision prefix is returned as a bare code — QC, ON, IL — because this
 * function cannot know the country. resolveRegion() below joins the two.
 */
export function splitRegionCell(value: string): RegionCell {
  const trimmed = value.trim()
  if (!trimmed) return { region: null, locality: null, territory: null }

  const slash = trimmed.indexOf('/')
  const left = (slash === -1 ? trimmed : trimmed.slice(0, slash)).trim()
  const territory = slash === -1 ? null : trimmed.slice(slash + 1).trim() || null

  // "QC - Saint-Jean-sur-Richelieu", or just "IL".
  const dash = left.match(/^([A-Za-z]{2})\s*[-–—]\s*(.+)$/)
  if (dash) {
    return { region: dash[1].toUpperCase(), locality: dash[2].trim() || null, territory }
  }

  if (/^[A-Za-z]{2}$/.test(left)) {
    return { region: left.toUpperCase(), locality: null, territory }
  }

  return { region: null, locality: left || null, territory }
}

/**
 * A bare subdivision code and a country make an ISO 3166-2 code.
 *
 * Returns null rather than guessing when the pair does not exist — "QC" with no
 * country, or a code that is not a subdivision of the country given. The
 * database refuses those anyway; catching it here means the review screen can
 * say so before anybody presses apply.
 */
export function resolveRegion(
  region: string | null,
  country: string | null,
  subdivisions: { code: string; country_code: string }[],
): string | null {
  if (!region || !country) return null
  const code = `${country.toUpperCase()}-${region.toUpperCase()}`
  return subdivisions.some((subdivision) => subdivision.code === code) ? code : null
}

/**
 * What "national", "North America" and "global" mean as a list of countries.
 *
 * Relative terms resolve against the company's own country, which is the only
 * reading that makes sense: "national" on a Canadian company means Canada.
 * "Global" resolves to nothing at all — a company that sells everywhere is not
 * usefully described by 249 checkboxes, and pretending otherwise would make
 * "sells in Mexico" match every global distributor in the file.
 */
export function resolveTerritory(
  hint: string | null,
  homeCountry: string | null,
  countries: CountryLookup[],
): { codes: string[]; unresolved: string | null } {
  if (!hint) return { codes: [], unresolved: null }

  const key = hint.trim().toLowerCase()
  if (!key) return { codes: [], unresolved: null }

  if (/^(national|nationwide|province-wide|domestic|country-wide|coast to coast)$/.test(key)) {
    return { codes: homeCountry ? [homeCountry] : [], unresolved: homeCountry ? null : hint }
  }

  if (/^(north america|n\.? america|na)$/.test(key)) {
    return { codes: ['CA', 'MX', 'US'], unresolved: null }
  }

  if (/^(global|worldwide|international|everywhere)$/.test(key)) {
    // Deliberately empty: see above.
    return { codes: [], unresolved: hint }
  }

  // Otherwise it may be a list of countries — "Canada and USA", "CA, US".
  const parts = key
    .split(/[,;/&]|\band\b|\bplus\b/)
    .map((part) => part.trim())
    .filter(Boolean)

  const codes: string[] = []
  const missed: string[] = []
  for (const part of parts) {
    const code = normaliseCountry(part, countries)
    if (code) codes.push(code)
    else missed.push(part)
  }

  return {
    codes: [...new Set(codes)].sort(),
    unresolved: missed.length > 0 ? hint : null,
  }
}

// -----------------------------------------------------------------------------
// Phones
// -----------------------------------------------------------------------------

/**
 * One cell to a list of numbers.
 *
 * The source file has ten formats — `905-327-9773`, `(289) 327-2499`,
 * `514.345.8000`, `+1 450-993-2121` — and two cells holding two numbers
 * separated by a semicolon. Storing those as typed means the same number is
 * three different strings and matching on it never works.
 *
 * North American numbers become +1XXXXXXXXXX. Anything already carrying a +
 * keeps its country code. Anything else is returned digits-and-plus only, which
 * is honest: this cannot know that a bare 9-digit number is Polish.
 */
export function normalisePhones(value: string): string[] {
  const parts = value
    .split(/[;\n]|\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)

  const numbers: string[] = []

  for (const part of parts) {
    const plus = part.trimStart().startsWith('+')
    const digits = part.replace(/\D/g, '')
    if (digits.length < 7) continue

    if (plus) {
      numbers.push(`+${digits}`)
    } else if (digits.length === 10) {
      numbers.push(`+1${digits}`)
    } else if (digits.length === 11 && digits.startsWith('1')) {
      numbers.push(`+${digits}`)
    } else {
      numbers.push(digits)
    }
  }

  return [...new Set(numbers)]
}

// -----------------------------------------------------------------------------
// Multi-valued cells
// -----------------------------------------------------------------------------

/**
 * A cell holding several values to a list of them.
 *
 * `Merchandise Fit` in the source file separates with `/` and `|` and runs to
 * 133 distinct values, most of which are two or three categories in one cell.
 * Values longer than the cutoff are prose rather than categories — "Customer
 * returns, overstock, shelf pulls, refurbished goods, mixed pallets" is a
 * sentence — and are returned separately so the review screen can show them
 * without pretending they are options.
 */
export function splitValues(
  value: string,
  { maxLength = 30 }: { maxLength?: number } = {},
): { values: string[]; prose: string | null } {
  const trimmed = value.trim()
  if (!trimmed) return { values: [], prose: null }

  /*
   * Pipe, slash and semicolon are always separators — nobody writes prose with
   * them in a category cell, and the semicolon is what a spreadsheet export
   * uses when the values themselves contain commas. Leaving it out made
   * "Distributor; Wholesaler" a single option on two thirds of the rows of a
   * real file.
   *
   * A comma is only a separator in a short cell: "Electronics, brand-name
   * closeouts" is two categories, while "Food, health and beauty, cleaning, pet
   * supplies, closeouts and excess inventory" is a sentence, and splitting the
   * second one produces six options that are not options.
   */
  const commaSeparates = trimmed.length <= 40
  const parts = trimmed
    .split(commaSeparates ? /[|/,;]/ : /[|/;]/)
    .map((part) => part.trim())
    .filter(Boolean)

  const values = parts.filter((part) => part.length <= maxLength)
  const long = parts.filter((part) => part.length > maxLength)

  return {
    values: [...new Set(values)],
    prose: long.length > 0 ? long.join('; ') : null,
  }
}

// -----------------------------------------------------------------------------
// Diffing
// -----------------------------------------------------------------------------

export type ChangeKind =
  /** The field was empty and the file has something. Safe. */
  | 'fill'
  /** Both have a value and they differ. A decision, not a fill. */
  | 'replace'
  /** Same value. Shown as unchanged, never written. */
  | 'same'

export interface FieldChange {
  field: string
  before: unknown
  after: unknown
  kind: ChangeKind
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index])
  }
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim()
  return a === b
}

/**
 * What an import would do to one existing record, field by field.
 *
 * The rule that matters is the distinction between 'fill' and 'replace'. Filling
 * a blank is what an import is for and can be approved in bulk without reading
 * it. Replacing "President" with "Buyer" is somebody's judgement being
 * overwritten by a spreadsheet, and it has to be shown as its own decision.
 *
 * An import must never silently turn a non-empty field into a different
 * non-empty value. Everything above this function exists to make that rule
 * enforceable rather than aspirational.
 */
export function diffRecord(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = []

  for (const [field, after] of Object.entries(incoming)) {
    // A blank in the file is not an instruction to clear the record. A column
    // somebody left empty means "I do not know", not "delete what you have".
    if (isBlank(after)) continue

    const before = existing[field]

    if (sameValue(before, after)) {
      changes.push({ field, before, after, kind: 'same' })
    } else if (isBlank(before)) {
      changes.push({ field, before, after, kind: 'fill' })
    } else {
      changes.push({ field, before, after, kind: 'replace' })
    }
  }

  return changes
}

/** Only the changes that would actually write something. */
export function writableChanges(changes: FieldChange[]): FieldChange[] {
  return changes.filter((change) => change.kind !== 'same')
}

// -----------------------------------------------------------------------------
// Matching
// -----------------------------------------------------------------------------

/** A domain, stripped of scheme, www and path, for comparing two of them. */
export function normaliseDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return null

  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  const host = withoutScheme.split(/[/?#]/)[0]?.replace(/^www\./, '')
  if (!host || !host.includes('.')) return null

  return host
}

/**
 * A company name reduced to the part that identifies it.
 *
 * Case, punctuation and the legal suffix all vary between sources —
 * "Bid Boss Inc", "Bid Boss Inc.", "BID BOSS INC" — and none of them is a
 * different company. Used only as the last resort, after domain and email,
 * because it is the one that can be wrong.
 */
export function normaliseCompanyName(value: string): string {
  return value
    .toLowerCase()
    // "Bank & Vogue" and "Bank and Vogue" are one company written two ways.
    .replace(/&/g, ' and ')
    .replace(/[.,]/g, '')
    .replace(/\b(inc|llc|ltd|ltee|ltée|limited|corp|corporation|co|company|gmbh|sarl|bv|nv|pty|plc)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export type MatchBasis = 'domain' | 'email' | 'name' | null

export interface MatchCandidate {
  id: string
  domain?: string | null
  email?: string | null
  name?: string | null
  based_in?: string | null
  /*
   * Whatever else the caller selected. A candidate is both the thing matched
   * against and the "before" side of the diff, and the diff has to reach every
   * column the import might write — not only the four used for matching.
   */
  [field: string]: unknown
}

/**
 * Finds the existing company a row refers to, or nothing.
 *
 * Deterministic and in this order on purpose: a domain is an identity, an email
 * address is nearly one, and a name is a guess. Returning the basis alongside
 * the match is what lets the review screen say *why* it thinks these are the
 * same company, which is the difference between a merge somebody can check and
 * one they have to trust.
 *
 * Name matching is narrowed by country when both sides have one. Two firms
 * called "Great Lakes Wholesale" on either side of the border are a real
 * possibility, and merging them is not recoverable.
 */
export function matchCompany(
  incoming: { domain?: string | null; email?: string | null; name?: string | null; based_in?: string | null },
  candidates: MatchCandidate[],
): { match: MatchCandidate | null; basis: MatchBasis } {
  const domain = incoming.domain ? normaliseDomain(incoming.domain) : null
  if (domain) {
    const hit = candidates.find(
      (candidate) => candidate.domain && normaliseDomain(candidate.domain) === domain,
    )
    if (hit) return { match: hit, basis: 'domain' }
  }

  const email = incoming.email?.trim().toLowerCase()
  if (email) {
    const hit = candidates.find((candidate) => candidate.email?.trim().toLowerCase() === email)
    if (hit) return { match: hit, basis: 'email' }
  }

  const name = incoming.name ? normaliseCompanyName(incoming.name) : ''
  if (name) {
    const hits = candidates.filter((candidate) => normaliseCompanyName(candidate.name ?? '') === name)

    const narrowed =
      incoming.based_in && hits.length > 1
        ? hits.filter((candidate) => !candidate.based_in || candidate.based_in === incoming.based_in)
        : hits

    // One is a match. Several is a question for a person, not a coin toss.
    if (narrowed.length === 1) return { match: narrowed[0], basis: 'name' }
  }

  return { match: null, basis: null }
}

// -----------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------

export interface GroupedRow {
  rowNumber: number
  values: Record<string, string>
}

export interface CompanyGroup {
  key: string
  name: string
  rows: GroupedRow[]
  /** Fields where the rows disagree, so the screen can say which and let somebody pick. */
  conflicts: { field: string; values: string[] }[]
}

/**
 * One company with its people, rather than one record per row.
 *
 * The source file is 257 rows and 203 companies: 32 names appear more than
 * once, because it is a contact list with the company repeated. Imported
 * row-by-row that becomes 257 companies, 54 of them duplicates of each other,
 * and no amount of later deduplication puts that back cleanly.
 *
 * Where two rows for one company disagree, both values are kept and reported.
 * In the source file the disagreements are almost all in the buyer-type column,
 * which turned out to be describing the row rather than the business — exactly
 * the kind of thing worth showing somebody instead of resolving silently.
 */
export function groupByCompany(
  rows: GroupedRow[],
  { nameField, companyFields }: { nameField: string; companyFields: string[] },
): CompanyGroup[] {
  const groups = new Map<string, CompanyGroup>()

  for (const row of rows) {
    const name = (row.values[nameField] ?? '').trim()
    if (!name) continue

    const key = normaliseCompanyName(name)
    const existing = groups.get(key)

    if (existing) existing.rows.push(row)
    else groups.set(key, { key, name, rows: [row], conflicts: [] })
  }

  for (const group of groups.values()) {
    for (const field of companyFields) {
      const values = [
        ...new Set(group.rows.map((row) => (row.values[field] ?? '').trim()).filter(Boolean)),
      ]
      if (values.length > 1) group.conflicts.push({ field, values })
    }
  }

  return [...groups.values()]
}

// -----------------------------------------------------------------------------
// Recognising a file
// -----------------------------------------------------------------------------

/**
 * A file's shape, as a string that can be compared.
 *
 * The headings, lower-cased, trimmed, sorted and joined. Sorted so a column
 * moving left or right does not look like a different file; lower-cased so a
 * changed capital does not either. The file's *name* is deliberately not part
 * of it — a list arrives called something different every month while its
 * columns stay put, which is exactly the thing worth matching on.
 */
export function headerSignature(headers: string[]): string {
  return [
    ...new Set(headers.map((header) => header.trim().toLowerCase()).filter(Boolean)),
  ]
    .sort()
    .join('|')
}
