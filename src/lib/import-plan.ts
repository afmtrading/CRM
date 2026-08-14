import {
  diffRecord,
  groupByCompany,
  matchCompany,
  normaliseCountry,
  normalisePhones,
  resolveRegion,
  resolveTerritory,
  splitRegionCell,
  splitValues,
  writableChanges,
  type CountryLookup,
  type FieldChange,
  type MatchBasis,
  type MatchCandidate,
} from '@/lib/import-analysis'

/**
 * Turning a parsed file into the thing somebody approves.
 *
 * Pure, and separate from both the screen and the server action, for the reason
 * every other module here says: the preview and the commit must run the same
 * code, or the preview is a guess about what will happen rather than a
 * statement of it.
 *
 * The unit is a company with its people, not a row. A contact list with the
 * company repeated — which is what a buyer list is — becomes one company and
 * several contacts, and importing it row by row instead produces a duplicate
 * company for every extra contact.
 */

// -----------------------------------------------------------------------------
// What a column can be mapped to
// -----------------------------------------------------------------------------

export interface TargetField {
  key: string
  label: string
  /** Which record it lands on. */
  on: 'company' | 'contact'
  /**
   * How the cell is read.
   *
   *   text        as typed, trimmed
   *   phone       to E.164, first number only
   *   country     a name, code or alias to alpha-2
   *   region      the compound cell — location on one side, territory on the other
   *   list        a multi-valued cell to separate values
   *   person      one name column to a first and a last
   */
  reads: 'text' | 'phone' | 'country' | 'region' | 'list' | 'person'
}

export const IMPORT_TARGETS: TargetField[] = [
  { key: 'company.name', label: 'Company name', on: 'company', reads: 'text' },
  { key: 'company.domain', label: 'Website', on: 'company', reads: 'text' },
  { key: 'company.email', label: 'Company email', on: 'company', reads: 'text' },
  { key: 'company.phone', label: 'Company phone', on: 'company', reads: 'phone' },
  { key: 'company.based_in', label: 'Country', on: 'company', reads: 'country' },
  /* One column, two facts. See splitRegionCell. */
  { key: 'company.region', label: 'Region (and territory)', on: 'company', reads: 'region' },
  { key: 'company.specialty_market', label: 'Merchandise', on: 'company', reads: 'list' },
  { key: 'company.stock_type', label: 'Stock type', on: 'company', reads: 'list' },
  { key: 'company.customer_type', label: 'Company type', on: 'company', reads: 'list' },
  { key: 'company.notes', label: 'Company notes', on: 'company', reads: 'text' },

  { key: 'contact.name', label: 'Contact name', on: 'contact', reads: 'person' },
  { key: 'contact.job_title', label: 'Title', on: 'contact', reads: 'text' },
  { key: 'contact.email', label: 'Contact email', on: 'contact', reads: 'text' },
  { key: 'contact.phone', label: 'Contact phone', on: 'contact', reads: 'phone' },
  { key: 'contact.linkedin', label: 'LinkedIn', on: 'contact', reads: 'text' },
  { key: 'contact.priority', label: 'Priority', on: 'contact', reads: 'text' },
  { key: 'contact.notes', label: 'Contact notes', on: 'contact', reads: 'text' },
]

/**
 * Column heading to target, by the words people actually use.
 *
 * Order is the whole design: the first pattern that matches wins, so the
 * specific ones come before the general. "LinkedIn / Person URL" has to reach
 * LinkedIn before the URL rule claims it, and "Company / Contact URL" has to
 * reach the website before the company rule claims it — both are real headings
 * from a real file, and both go to the wrong place under any other ordering.
 */
const HEADER_HINTS: { pattern: RegExp; target: string }[] = [
  { pattern: /linkedin/i, target: 'contact.linkedin' },
  { pattern: /(website|url|web site|domain)/i, target: 'company.domain' },
  { pattern: /(e-?mail)/i, target: 'contact.email' },
  { pattern: /(phone|tel\b|mobile)/i, target: 'contact.phone' },
  { pattern: /^country/i, target: 'company.based_in' },
  { pattern: /^(region|state|province|territory)/i, target: 'company.region' },
  { pattern: /(merchandise|market|category|product fit|goods)/i, target: 'company.specialty_market' },
  { pattern: /(stock type|condition|inventory type)/i, target: 'company.stock_type' },
  { pattern: /(buyer type|company type|client type|customer type|account type)/i, target: 'company.customer_type' },
  { pattern: /(title|department|role|position|job)/i, target: 'contact.job_title' },
  { pattern: /(priority|tier|rank)/i, target: 'contact.priority' },
  { pattern: /^(contact name|name|person|buyer name)/i, target: 'contact.name' },
  { pattern: /^(company|business|organi[sz]ation|account|channel)/i, target: 'company.name' },
]

/**
 * A first guess at the mapping, so the step starts mostly filled in.
 *
 * Order matters: the most specific pattern that matches wins, and a column
 * already claimed is not claimed twice. "Company / Contact URL" must land on
 * the website rather than on the company name, which is why the website test
 * comes before the general company one at the point of use.
 */
export function suggestTargets(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {}
  const taken = new Set<string>()

  for (const header of headers) {
    const cleaned = header.trim()
    if (!cleaned) continue

    // A target is claimed once. A file with both "Email" and "Company Email"
    // gives the first one the contact's email and leaves the second for
    // somebody to place, rather than silently overwriting the mapping.
    const hit = HEADER_HINTS.find((hint) => hint.pattern.test(cleaned) && !taken.has(hint.target))
    if (!hit) continue

    mapping[cleaned] = hit.target
    taken.add(hit.target)
  }

  return mapping
}

// -----------------------------------------------------------------------------
// Reading one row
// -----------------------------------------------------------------------------

export interface ReadContext {
  countries: CountryLookup[]
  subdivisions: { code: string; country_code: string }[]
  /** Values in the contact-name column that are not people. */
  placeholders: Set<string>
}

export interface ReadRow {
  rowNumber: number
  company: Record<string, unknown>
  contact: Record<string, unknown> | null
  /**
   * Something was read differently from how it was written, and it worked.
   * Worth being able to see; not worth stopping for.
   */
  notes: string[]
  /**
   * Something could not be read and was left out. These are what "needs a look"
   * counts, and keeping them apart from notes is what stops the count reading
   * 185 of 202 — at which point nobody looks at any of them.
   */
  warnings: string[]
}

/**
 * Splits one name column into a first and a last.
 *
 * First token, everything else the surname — so "Justinian La Rosa" is
 * Justinian La Rosa rather than "Justinian La" Rosa. Taking the *last* token as
 * the surname is the other common convention and is better for middle names,
 * but worse for the particles that are everywhere in a Quebec or European buyer
 * list: La, De, Van der, Di. Those are more common here than middle names.
 *
 * Neither reading is right in every case. This one is wrong less often on the
 * lists this business actually receives.
 */
function splitPerson(value: string): { first_name: string; last_name: string } {
  const parts = value.trim().split(/\s+/)
  if (parts.length === 1) return { first_name: parts[0], last_name: '' }
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') }
}

export function readRow(
  rowNumber: number,
  values: Record<string, string>,
  mapping: Record<string, string>,
  context: ReadContext,
): ReadRow {
  const company: Record<string, unknown> = {}
  const contact: Record<string, unknown> = {}
  const notes: string[] = []
  const warnings: string[] = []
  let placeholderName = false

  const cellFor = (target: string): string => {
    const header = Object.keys(mapping).find((key) => mapping[key] === target)
    return header ? (values[header] ?? '').trim() : ''
  }

  const target = (key: string) => IMPORT_TARGETS.find((field) => field.key === key)

  for (const [, key] of Object.entries(mapping)) {
    const field = target(key)
    if (!field) continue

    const raw = cellFor(key)
    if (!raw) continue

    const column = key.split('.')[1]
    const bag = field.on === 'company' ? company : contact

    switch (field.reads) {
      case 'phone': {
        const numbers = normalisePhones(raw)
        if (numbers.length === 0) {
          warnings.push(`Could not read a phone number from "${raw}"`)
        } else {
          bag[column] = numbers[0]
          if (numbers.length > 1) notes.push(`Kept the first of ${numbers.length} phone numbers`)
        }
        break
      }

      case 'country': {
        const code = normaliseCountry(raw, context.countries)
        if (code) bag.based_in = code
        else warnings.push(`"${raw}" is not a country`)
        break
      }

      case 'list': {
        const { values: split, prose } = splitValues(raw)
        if (split.length > 0) bag[column] = split
        if (prose) notes.push(`"${prose}" is prose rather than a category — left out`)
        break
      }

      case 'person': {
        if (context.placeholders.has(raw)) {
          placeholderName = true
          notes.push(`"${raw}" is a placeholder, not a person — imported as a company channel`)
          break
        }
        Object.assign(contact, splitPerson(raw))
        break
      }

      case 'region':
        // Handled after the loop: it needs the country, which may be mapped
        // from a column that comes later.
        break

      default:
        bag[column] = raw
    }
  }

  const regionCell = cellFor('company.region')
  if (regionCell) {
    const parts = splitRegionCell(regionCell)
    const country = (company.based_in as string | undefined) ?? null

    const region = resolveRegion(parts.region, country, context.subdivisions)
    if (region) company.based_in_region = region
    else if (parts.region)
      warnings.push(`"${parts.region}" is not a region of ${country ?? 'anywhere known'}`)

    const territory = resolveTerritory(parts.territory, country, context.countries)
    if (territory.codes.length > 0) company.sells_in = territory.codes
    if (territory.unresolved) warnings.push(`Could not read "${territory.unresolved}" as a territory`)
  }

  /*
   * "Company intake" means "no named contact — use the company's general
   * channel", so the row's email and phone belong to the company. Creating a
   * contact with an address and no name would be the worst of both: a person
   * who does not exist, who cannot be greeted by name in any email sent to
   * them.
   */
  if (placeholderName) {
    if (contact.email && !company.email) company.email = contact.email
    if (contact.phone && !company.phone) company.phone = contact.phone
    return { rowNumber, company, contact: null, notes, warnings }
  }

  // A contact with nothing but a title is not a contact.
  const hasPerson = Boolean(contact.first_name)

  return {
    rowNumber,
    company,
    contact: hasPerson ? contact : null,
    notes,
    warnings,
  }
}

// -----------------------------------------------------------------------------
// The plan
// -----------------------------------------------------------------------------

export interface PlannedCompany {
  key: string
  name: string
  rowNumbers: number[]
  /** What the file says, merged across this company's rows. */
  values: Record<string, unknown>
  /** The existing record this refers to, if one was found. */
  matchId: string | null
  matchBasis: MatchBasis
  /** Empty for a new company; field-by-field for an existing one. */
  changes: FieldChange[]
  contacts: { rowNumber: number; values: Record<string, unknown> }[]
  conflicts: { field: string; values: string[] }[]
  notes: string[]
  warnings: string[]
}

export interface ImportPlan {
  companies: PlannedCompany[]
  counts: {
    rows: number
    newCompanies: number
    updatedCompanies: number
    unchangedCompanies: number
    contacts: number
    needsAttention: number
  }
}

/**
 * Merging a company's rows into one set of values.
 *
 * First value wins, because the rows are in file order and the first mention of
 * a company is usually its fullest. Where they genuinely disagree the conflict
 * is reported rather than resolved — see groupByCompany.
 */
function mergeCompanyValues(rows: ReadRow[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}

  for (const row of rows) {
    for (const [field, value] of Object.entries(row.company)) {
      if (value === null || value === undefined || value === '') continue
      if (Array.isArray(value) && value.length === 0) continue

      if (merged[field] === undefined) {
        merged[field] = value
      } else if (Array.isArray(merged[field]) && Array.isArray(value)) {
        // Lists are the one case where two rows add up rather than compete: a
        // company selling apparel on one row and uniforms on another sells
        // both.
        merged[field] = [...new Set([...(merged[field] as string[]), ...value])].sort()
      }
    }
  }

  return merged
}

export function buildPlan(
  rows: { rowNumber: number; values: Record<string, string> }[],
  mapping: Record<string, string>,
  context: ReadContext,
  existing: MatchCandidate[],
): ImportPlan {
  const nameHeader = Object.keys(mapping).find((key) => mapping[key] === 'company.name')
  if (!nameHeader) {
    return {
      companies: [],
      counts: {
        rows: rows.length,
        newCompanies: 0,
        updatedCompanies: 0,
        unchangedCompanies: 0,
        contacts: 0,
        needsAttention: 0,
      },
    }
  }

  const groups = groupByCompany(rows, { nameField: nameHeader, companyFields: [] })
  const readByRow = new Map(
    rows.map((row) => [row.rowNumber, readRow(row.rowNumber, row.values, mapping, context)]),
  )

  const companies: PlannedCompany[] = []

  for (const group of groups) {
    const read = group.rows
      .map((row) => readByRow.get(row.rowNumber))
      .filter((row): row is ReadRow => Boolean(row))

    const values = mergeCompanyValues(read)
    values.name = group.name

    const { match, basis } = matchCompany(
      {
        domain: values.domain as string | undefined,
        email: values.email as string | undefined,
        name: group.name,
        based_in: values.based_in as string | undefined,
      },
      existing,
    )

    const changes = match ? diffRecord(match, values) : []

    // Where two rows for one company give different single values, that is
    // worth a person's eye rather than a silent first-wins.
    const conflicts: { field: string; values: string[] }[] = []
    for (const field of ['based_in', 'based_in_region', 'domain', 'phone']) {
      const seen = [
        ...new Set(
          read
            .map((row) => row.company[field])
            .filter((value): value is string => typeof value === 'string' && value !== ''),
        ),
      ]
      if (seen.length > 1) conflicts.push({ field, values: seen })
    }

    companies.push({
      key: group.key,
      name: group.name,
      rowNumbers: read.map((row) => row.rowNumber),
      values,
      matchId: match?.id ?? null,
      matchBasis: basis,
      changes,
      contacts: read
        .filter((row) => row.contact)
        .map((row) => ({ rowNumber: row.rowNumber, values: row.contact as Record<string, unknown> })),
      conflicts,
      notes: [...new Set(read.flatMap((row) => row.notes))],
      warnings: [...new Set(read.flatMap((row) => row.warnings))],
    })
  }

  const updated = companies.filter(
    (company) => company.matchId && writableChanges(company.changes).length > 0,
  )
  const unchanged = companies.filter(
    (company) => company.matchId && writableChanges(company.changes).length === 0,
  )

  return {
    companies,
    counts: {
      rows: rows.length,
      newCompanies: companies.filter((company) => !company.matchId).length,
      updatedCompanies: updated.length,
      unchangedCompanies: unchanged.length,
      contacts: companies.reduce((total, company) => total + company.contacts.length, 0),
      needsAttention: companies.filter(
        (company) => company.warnings.length > 0 || company.conflicts.length > 0,
      ).length,
    },
  }
}
