import {
  diffRecord,
  groupByCompany,
  matchCompany,
  normaliseCountry,
  normalisePhones,
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
  reads:
    | 'text'
    | 'phone'
    | 'country'
    | 'region'
    | 'list'
    | 'person'
    /** A list of places this company sells into, to country and region codes. */
    | 'territory'
    /** A person's name or email, to one of this organization's users. */
    | 'owner'
    /** A multi-valued cell to tag names, attached rather than written. */
    | 'tags'
}

export const IMPORT_TARGETS: TargetField[] = [
  { key: 'company.name', label: 'Company name', on: 'company', reads: 'text' },
  { key: 'company.domain', label: 'Website', on: 'company', reads: 'text' },
  { key: 'company.email', label: 'Company email', on: 'company', reads: 'text' },
  { key: 'company.phone', label: 'Company phone', on: 'company', reads: 'phone' },
  { key: 'company.based_in', label: 'Base Country', on: 'company', reads: 'country' },
  { key: 'company.sells_in', label: 'Sells To', on: 'company', reads: 'territory' },
  /*
   * Only half of this one survives now.
   *
   * It was written when a company had a subdivision column to put "Ontario"
   * in. That column is gone, so the location half is read and dropped and only
   * a territory after a slash reaches sells_in. The label says so, because a
   * column that silently discards what you mapped to it is worse than one you
   * were told not to bother with — and "Sells To" above is where a plain list
   * of territories should go.
   */
  {
    key: 'company.region',
    label: 'Region — only a territory after a slash is kept',
    on: 'company',
    reads: 'region',
  },
  { key: 'company.specialty_market', label: 'Merchandise', on: 'company', reads: 'list' },
  { key: 'company.stock_type', label: 'Stock type', on: 'company', reads: 'list' },
  { key: 'company.customer_type', label: 'Company type', on: 'company', reads: 'list' },
  { key: 'company.priority', label: 'Priority', on: 'company', reads: 'text' },
  { key: 'company.owner_id', label: 'Owner', on: 'company', reads: 'owner' },
  { key: 'company.tags', label: 'Tags', on: 'company', reads: 'tags' },
  { key: 'company.notes', label: 'Company notes', on: 'company', reads: 'text' },

  { key: 'contact.name', label: 'Contact name (one column)', on: 'contact', reads: 'person' },
  /* For the files that keep them apart, which the one-column reader cannot. */
  { key: 'contact.first_name', label: 'First name', on: 'contact', reads: 'text' },
  { key: 'contact.last_name', label: 'Last name', on: 'contact', reads: 'text' },
  { key: 'contact.job_title', label: 'Title', on: 'contact', reads: 'text' },
  { key: 'contact.email', label: 'Contact email', on: 'contact', reads: 'text' },
  { key: 'contact.phone', label: 'Contact phone', on: 'contact', reads: 'phone' },
  { key: 'contact.linkedin', label: 'LinkedIn', on: 'contact', reads: 'text' },
  { key: 'contact.priority', label: 'Priority', on: 'contact', reads: 'text' },
  { key: 'contact.owner_id', label: 'Owner', on: 'contact', reads: 'owner' },
  { key: 'contact.tags', label: 'Tags', on: 'contact', reads: 'tags' },
  { key: 'contact.notes', label: 'Contact notes', on: 'contact', reads: 'text' },
]

/** The prefix that marks a target as one of an organization's own fields. */
const CUSTOM = 'custom_fields.'

/**
 * Every target this organization can map to, its own fields included.
 *
 * The built-in list is fixed; custom fields are not, so the offer has to be
 * built per organization rather than declared. Without this the buyer-list
 * screen was the only importer that could not reach a field somebody had
 * defined themselves — the plain one has offered them since it was written.
 */
export function importTargets(
  customFields: { key: string; label: string; entity_type: string }[] = [],
): TargetField[] {
  const custom = customFields
    .filter((definition) => definition.entity_type === 'company' || definition.entity_type === 'contact')
    .map((definition): TargetField => ({
      key: `${definition.entity_type}.${CUSTOM}${definition.key}`,
      label: `${definition.label} (your field)`,
      on: definition.entity_type === 'company' ? 'company' : 'contact',
      reads: 'text',
    }))

  return [...IMPORT_TARGETS, ...custom]
}

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
  /*
   * Qualified before bare.
   *
   * "Company email" is an email, so a rule matching /email/ claims it — and
   * the contact's rule used to come first, which put a business's switchboard
   * address on a person who did not exist. Anything that names the record it
   * belongs to has to be settled before the generic rule for that kind of
   * value gets a look.
   */
  { pattern: /^company (e-?mail)/, target: 'company.email' },
  { pattern: /^company (phone|tel|number)/, target: 'company.phone' },
  { pattern: /^company (name)/, target: 'company.name' },
  { pattern: /^(contact|person|buyer) (e-?mail)/, target: 'contact.email' },
  { pattern: /^(contact|person|buyer) (phone|tel|mobile)/, target: 'contact.phone' },

  { pattern: /linkedin/, target: 'contact.linkedin' },
  { pattern: /(website|url|web site|domain)/, target: 'company.domain' },

  { pattern: /^(first|given) ?name/, target: 'contact.first_name' },
  { pattern: /^(last|family) ?name|^surname/, target: 'contact.last_name' },

  /*
   * Unanchored, because the field is called "Base Country" — the app's own
   * name for it since 20260250 — and an anchored /^country/ does not match its
   * own label. "Sells to" comes first so it is not swallowed by it.
   */
  { pattern: /(sells? ?to|sells? ?in|territor|markets? served)/, target: 'company.sells_in' },
  { pattern: /country/, target: 'company.based_in' },
  { pattern: /^(region|state|province)/, target: 'company.region' },

  { pattern: /(merchandise|market|category|product fit|goods)/, target: 'company.specialty_market' },
  { pattern: /(stock type|condition|inventory type)/, target: 'company.stock_type' },
  {
    pattern: /(buyer type|company type|client type|customer type|account type)/,
    target: 'company.customer_type',
  },
  { pattern: /(title|department|role|position|job)/, target: 'contact.job_title' },

  { pattern: /(e-?mail)/, target: 'contact.email' },
  { pattern: /(phone|tel\b|mobile)/, target: 'contact.phone' },

  { pattern: /^(contact name|name|person|buyer name)/, target: 'contact.name' },
  { pattern: /^(company|business|organi[sz]ation|account|channel)/, target: 'company.name' },
]

/**
 * Hints whose record depends on what else the file holds.
 *
 * "Priority", "Owner", "Tags" and "Notes" are asked of a company and of a
 * person in the same words, and a buyer list carries both. Guessing one and
 * being wrong is not a neutral mistake: pointing a contact file's Priority at
 * the company would rewrite the priority of every company on it.
 *
 * So the file decides. A file that names people is read as a list of people;
 * one that does not is read as a list of companies.
 */
const AMBIGUOUS: { pattern: RegExp; company: string; contact: string }[] = [
  { pattern: /(priority|tier|rank)/, company: 'company.priority', contact: 'contact.priority' },
  { pattern: /^(owner|assigned|account manager|rep)/, company: 'company.owner_id', contact: 'contact.owner_id' },
  { pattern: /^tags?$|^labels?$/, company: 'company.tags', contact: 'contact.tags' },
  { pattern: /^(notes?|comments?|description)/, company: 'company.notes', contact: 'contact.notes' },
]

/** Separators vary; the words do not. `stock_type` and "Stock type" are one heading. */
function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Whether the file names people, which decides who the shared headings belong to. */
function namesPeople(headers: string[]): boolean {
  return headers.some((header) => {
    const cleaned = normaliseHeader(header)
    return /^(first|given|last|family) ?name/.test(cleaned) ||
      /^surname$/.test(cleaned) ||
      /^(contact|person|buyer) name/.test(cleaned) ||
      /^full name$/.test(cleaned)
  })
}

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
  const people = namesPeople(headers)

  for (const header of headers) {
    const original = header.trim()
    if (!original) continue

    const cleaned = normaliseHeader(header)
    if (!cleaned) continue

    // A target is claimed once. A file with both "Email" and "Company Email"
    // gives the first one the contact's email and leaves the second for
    // somebody to place, rather than silently overwriting the mapping.
    const shared = AMBIGUOUS.find((hint) => hint.pattern.test(cleaned))
    const target = shared
      ? people
        ? shared.contact
        : shared.company
      : HEADER_HINTS.find((hint) => hint.pattern.test(cleaned) && !taken.has(hint.target))?.target

    if (!target || taken.has(target)) continue

    mapping[original] = target
    taken.add(target)
  }

  return mapping
}

// -----------------------------------------------------------------------------
// Reading one row
// -----------------------------------------------------------------------------

export interface ReadContext {
  countries: CountryLookup[]
  /** Values in the contact-name column that are not people. */
  placeholders: Set<string>
  /** This organization's people, for resolving an owner column to one of them. */
  users?: { id: string; name: string; email: string }[]
  /** Every target on offer, so a custom field is read rather than ignored. */
  targets?: TargetField[]
}

/**
 * One name in an owner column, to one of this organization's users.
 *
 * A list says "Emile", not a uuid. Matched on the email, then the whole name,
 * then the first name — and only when exactly one person answers to it. Two
 * Emiles means the file cannot say which, and guessing would hand somebody
 * else's accounts to the wrong rep silently.
 */
export function resolveOwner(
  raw: string,
  users: { id: string; name: string; email: string }[],
): { id: string | null; ambiguous: boolean } {
  const key = raw.trim().toLowerCase()
  if (!key) return { id: null, ambiguous: false }

  const exact = users.filter(
    (user) => user.email.toLowerCase() === key || user.name.trim().toLowerCase() === key,
  )
  if (exact.length === 1) return { id: exact[0].id, ambiguous: false }
  if (exact.length > 1) return { id: null, ambiguous: true }

  const byFirstName = users.filter(
    (user) => user.name.trim().toLowerCase().split(/\s+/)[0] === key,
  )
  if (byFirstName.length === 1) return { id: byFirstName[0].id, ambiguous: false }

  return { id: null, ambiguous: byFirstName.length > 1 }
}

export interface ReadRow {
  rowNumber: number
  company: Record<string, unknown>
  contact: Record<string, unknown> | null
  /*
   * Tags are kept out of the value bags on purpose. Those bags are written
   * straight to their table and diffed column by column against the record
   * that is already there; a tag is neither a column nor a value that could be
   * diffed that way, so putting it in would break both.
   */
  companyTags: string[]
  contactTags: string[]
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
  const companyTags: string[] = []
  const contactTags: string[] = []
  const notes: string[] = []
  const warnings: string[] = []
  let placeholderName = false

  const cellFor = (target: string): string => {
    const header = Object.keys(mapping).find((key) => mapping[key] === target)
    return header ? (values[header] ?? '').trim() : ''
  }

  const offered = context.targets ?? IMPORT_TARGETS
  const target = (key: string) => offered.find((field) => field.key === key)

  for (const [, key] of Object.entries(mapping)) {
    const field = target(key)
    if (!field) continue

    const raw = cellFor(key)
    if (!raw) continue

    const bag = field.on === 'company' ? company : contact

    /*
     * An organization's own field is a key inside one jsonb column rather than
     * a column of its own, so it is settled here instead of in the switch —
     * every branch below writes a column, and this writes into a bag on one.
     */
    const rest = key.slice(key.indexOf('.') + 1)
    if (rest.startsWith(CUSTOM)) {
      const existing = (bag.custom_fields as Record<string, unknown> | undefined) ?? {}
      bag.custom_fields = { ...existing, [rest.slice(CUSTOM.length)]: raw }
      continue
    }

    const column = rest

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

      case 'tags': {
        const { values: split } = splitValues(raw)
        ;(field.on === 'company' ? companyTags : contactTags).push(...split)
        break
      }

      case 'owner': {
        const users = context.users ?? []
        if (users.length === 0) break

        const { id, ambiguous } = resolveOwner(raw, users)
        if (id) bag.owner_id = id
        else if (ambiguous) warnings.push(`More than one person is called "${raw}" — owner left unset`)
        else warnings.push(`No user called "${raw}" — owner left unset`)
        break
      }

      case 'territory':
      case 'region':
        // Both handled after the loop: they need the country, which may be
        // mapped from a column that comes later.
        break

      default:
        bag[column] = raw
    }
  }

  /*
   * Where they sell, as its own column — which is the ordinary way a list says
   * it, and until now had nowhere to go. Read after the loop for the same
   * reason the region cell is: "national" only means something once the home
   * country is known.
   */
  const territoryCell = cellFor('company.sells_in')
  if (territoryCell) {
    const resolved = resolveTerritory(
      territoryCell,
      (company.based_in as string | undefined) ?? null,
      context.countries,
    )
    if (resolved.codes.length > 0) company.sells_in = resolved.codes
    if (resolved.unresolved) {
      warnings.push(`Could not read "${resolved.unresolved}" as a place they sell to`)
    }
  }

  /*
   * One column still arrives holding two facts — "Ontario / sells across North
   * America" — and only the second half has anywhere to go now that the
   * subdivision column is gone. The region half is read and dropped rather
   * than warned about: the file has not changed, and telling somebody their
   * spreadsheet is wrong when the app is what stopped asking would be a lie.
   */
  const regionCell = cellFor('company.region')
  if (regionCell) {
    const parts = splitRegionCell(regionCell)
    const country = (company.based_in as string | undefined) ?? null

    const territory = resolveTerritory(parts.territory, country, context.countries)
    // A Sells To column of its own is the better statement of the same fact,
    // so a territory smuggled inside a region cell never overwrites one.
    if (territory.codes.length > 0 && !company.sells_in) company.sells_in = territory.codes
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
    // A row with no person on it has nobody to tag, so those tags are the
    // company's — the same reasoning that moved the email and phone up.
    return {
      rowNumber,
      company,
      contact: null,
      companyTags: [...companyTags, ...contactTags],
      contactTags: [],
      notes,
      warnings,
    }
  }

  // A contact with nothing but a title is not a contact.
  const hasPerson = Boolean(contact.first_name)

  return {
    rowNumber,
    company,
    contact: hasPerson ? contact : null,
    companyTags,
    contactTags: hasPerson ? contactTags : [],
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
  /** Tag names from every row for this company, unioned. Attached, not written. */
  tags: string[]
  contacts: { rowNumber: number; values: Record<string, unknown>; tags: string[] }[]
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
    for (const field of ['based_in', 'domain', 'phone']) {
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
      // Unioned across the rows rather than first-wins: two rows for one
      // company naming different tags mean it has both, not that they disagree.
      tags: [...new Set(read.flatMap((row) => row.companyTags))],
      contacts: read
        .filter((row) => row.contact)
        .map((row) => ({
          rowNumber: row.rowNumber,
          values: row.contact as Record<string, unknown>,
          tags: [...new Set(row.contactTags)],
        })),
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
