/**
 * Filtering, grouping and saved filters (PRD 6.6).
 *
 * A filter is plain JSON so it can be stored in SavedFilter.filter_json and
 * replayed on any device. Everything here is pure — it turns that JSON into
 * PostgREST predicates — which is what makes it directly testable.
 */

import type { CustomFieldDefinitionRow, FilterEntityType } from '@/lib/database.types'

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'starts_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  /*
   * Set operations on an array column — territories, above all.
   *
   *   has_all     sells in Canada AND the USA, whatever else
   *   has_any     sells in Canada OR the USA
   *   has_none    sells in neither
   *   is_exactly  sells in Canada and the USA and nowhere else
   *
   * is_exactly is an equality test on an array, which only means what it says
   * because the database sorts and de-duplicates these columns on write. See
   * normalise_territory() in 20260238000000.
   */
  | 'has_all'
  | 'has_any'
  | 'has_none'
  | 'is_exactly'

export interface FilterCondition {
  field: string
  operator: FilterOperator
  value?: string | number | boolean | string[] | null
}

export interface FilterConfig {
  /** 'all' = AND across conditions, 'any' = OR. */
  match: 'all' | 'any'
  conditions: FilterCondition[]
  search?: string
  groupBy?: string | null
  /** A second level inside each group. Ignored unless groupBy is set. */
  subGroupBy?: string | null
  sort?: { field: string; direction: 'asc' | 'desc' } | null
}

export const EMPTY_FILTER: FilterConfig = {
  match: 'all',
  conditions: [],
  search: '',
  groupBy: null,
  subGroupBy: null,
  sort: null,
}

export interface FieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'boolean' | 'enum' | 'uuid' | 'array'
  /** Options for enum fields, and for reference fields resolved by the caller. */
  options?: { value: string; label: string }[]
  groupable?: boolean
  sortable?: boolean
}

export const CONTACT_FIELDS: FieldDef[] = [
  { key: 'first_name', label: 'First name', type: 'text', sortable: true },
  { key: 'last_name', label: 'Last name', type: 'text', sortable: true },
  { key: 'email', label: 'Email', type: 'text', sortable: true },
  { key: 'phone', label: 'Phone', type: 'text' },
  {
    key: 'lifecycle_stage',
    label: 'Lifecycle stage',
    type: 'enum',
    groupable: true,
    sortable: true,
    options: [
      { value: 'lead', label: 'Lead' },
      { value: 'qualified', label: 'Qualified' },
      { value: 'customer', label: 'Customer' },
      { value: 'other', label: 'Other' },
    ],
  },
  { key: 'source', label: 'Source', type: 'text', groupable: true, sortable: true },
  { key: 'lead_score', label: 'Lead score', type: 'number', sortable: true },
  { key: 'owner_id', label: 'Owner', type: 'uuid', groupable: true },
  { key: 'company_id', label: 'Company', type: 'uuid', groupable: true },
  { key: 'created_at', label: 'Created', type: 'date', sortable: true },
  { key: 'updated_at', label: 'Updated', type: 'date', sortable: true },
]

export const COMPANY_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', sortable: true },
  { key: 'domain', label: 'Domain', type: 'text', sortable: true },
  { key: 'industry', label: 'Industry', type: 'text', groupable: true, sortable: true },
  { key: 'priority', label: 'Priority', type: 'enum', groupable: true, sortable: true },
  { key: 'owner_id', label: 'Owner', type: 'uuid', groupable: true },
  /*
   * Where they are and where they trade, as three separate questions.
   *
   * based_in groups usefully — "how many of our buyers are in Canada" is a
   * sensible column heading. The territories do not: a company selling in six
   * countries belongs to six groups at once, and a grouped list would either
   * repeat it or pick one arbitrarily.
   */
  { key: 'based_in', label: 'Base Country', type: 'enum', groupable: true, sortable: true },
  { key: 'sells_in', label: 'Sells To', type: 'array' },
  { key: 'specialty_market', label: 'Merchandise', type: 'array' },
  { key: 'stock_type', label: 'Stock type', type: 'array' },
  { key: 'customer_type', label: 'Company type', type: 'array' },
  { key: 'created_at', label: 'Created', type: 'date', sortable: true },
]

export const DEAL_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', sortable: true },
  {
    key: 'status',
    label: 'Status',
    type: 'enum',
    groupable: true,
    sortable: true,
    options: [
      { value: 'open', label: 'Open' },
      { value: 'won', label: 'Won' },
      { value: 'lost', label: 'Lost' },
    ],
  },
  { key: 'stage_id', label: 'Stage', type: 'uuid', groupable: true },
  { key: 'value', label: 'Value', type: 'number', sortable: true },
  { key: 'currency', label: 'Currency', type: 'text', groupable: true },
  { key: 'probability', label: 'Probability', type: 'number', sortable: true },
  { key: 'owner_id', label: 'Owner', type: 'uuid', groupable: true },
  { key: 'expected_close_date', label: 'Expected close', type: 'date', sortable: true },
]

export const PRODUCT_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', sortable: true },
  { key: 'sku', label: 'SKU', type: 'text', sortable: true },
  { key: 'brand', label: 'Brand', type: 'text', groupable: true, sortable: true },
  { key: 'category', label: 'Category', type: 'text', groupable: true, sortable: true },
  { key: 'product_type', label: 'Product type', type: 'enum', groupable: true, sortable: true },
  { key: 'status', label: 'Status', type: 'enum', groupable: true, sortable: true },
  { key: 'currency', label: 'Currency', type: 'text', groupable: true },
  { key: 'unit_price', label: 'Retail price', type: 'number', sortable: true },
  { key: 'unit_cost', label: 'Unit cost', type: 'number', sortable: true },
  { key: 'case_pack', label: 'Case pack', type: 'number', sortable: true },
  /*
   * `active` is deliberately not here. Whether retired products are on the page
   * at all is a base predicate on the query, toggled beside the list, and
   * offering it as a condition as well would be two controls that contradict
   * each other the moment they disagree.
   */
  { key: 'created_at', label: 'Created', type: 'date', sortable: true },
]

/*
 * A marketplace row is a company with its profile embedded, so the fields come
 * from both halves and the dotted ones belong to the profile.
 *
 * They are the reason the marketplaces list filters in memory rather than in
 * the query: `conditionToPredicate` packs a condition into
 * `column.operator.value` and `applyFilter` splits it on the first dot, so a
 * column whose own name contains one cannot survive the round trip. Rewriting
 * that packing would touch every list in the app to serve one; evaluating a few
 * dozen marketplaces in memory does not.
 */
export const MARKETPLACE_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', sortable: true },
  { key: 'priority', label: 'Priority', type: 'enum', groupable: true, sortable: true },
  { key: 'owner_id', label: 'Owner', type: 'uuid', groupable: true },
  { key: 'based_in', label: 'Base Country', type: 'enum', groupable: true, sortable: true },
  { key: 'domain', label: 'Website', type: 'text' },
  { key: 'sells_in', label: 'Sells To', type: 'array' },
  { key: 'specialty_market', label: 'Merchandise', type: 'array' },

  { key: 'marketplace_profiles.marketplace_type', label: 'Marketplace type', type: 'array' },
  { key: 'marketplace_profiles.fulfilment', label: 'Fulfilment', type: 'array' },
  { key: 'marketplace_profiles.audience', label: 'Audience', type: 'array' },
  { key: 'marketplace_profiles.inventory_type', label: 'Inventory type', type: 'array' },
  { key: 'marketplace_profiles.payment', label: 'Payment', type: 'enum', groupable: true },
  { key: 'marketplace_profiles.selling_cost', label: 'Selling cost', type: 'enum', groupable: true },
  { key: 'marketplace_profiles.buyers_premium', label: "Buyer's premium", type: 'boolean' },
  {
    key: 'marketplace_profiles.account_status',
    label: 'Account status',
    type: 'enum',
    groupable: true,
  },
  {
    key: 'marketplace_profiles.payout_currency',
    label: 'Payout currency',
    type: 'text',
    groupable: true,
  },
  { key: 'marketplace_profiles.sells_through', label: 'Sell through', type: 'boolean' },
  { key: 'marketplace_profiles.sources_from', label: 'Source from', type: 'boolean' },
  { key: 'marketplace_profiles.settlement_terms', label: 'Settlement terms', type: 'text' },
  { key: 'marketplace_profiles.opened_on', label: 'Opened', type: 'date', sortable: true },
]

export function baseFieldsFor(entity: FilterEntityType): FieldDef[] {
  switch (entity) {
    case 'company':
      return COMPANY_FIELDS
    case 'deal':
      return DEAL_FIELDS
    case 'product':
      return PRODUCT_FIELDS
    case 'marketplace':
      return MARKETPLACE_FIELDS
    default:
      return CONTACT_FIELDS
  }
}

/** Custom fields become first-class filterable columns (PRD 6.6: "any … custom field"). */
export function fieldsFor(
  entity: FilterEntityType,
  customFields: CustomFieldDefinitionRow[] = [],
  /**
   * Option values for select-type custom fields. They live in field_options
   * alongside the built-in lists, so the filter dropdown has to be told about
   * them rather than reading the definition.
   */
  fieldOptions: { entity_type: string; field_key: string; value: string }[] = [],
): FieldDef[] {
  const custom: FieldDef[] = customFields
    .filter((definition) => definition.entity_type === entity)
    .map((definition) => ({
      key: `custom_fields.${definition.key}`,
      label: definition.label,
      // Both select flavours filter as an enum: a multiselect stores an array,
      // but the question a filter asks of it is still "is this one of these".
      type:
        definition.field_type === 'select' || definition.field_type === 'multiselect'
          ? 'enum'
          : definition.field_type,
      groupable: true,
      sortable: false,
      options: fieldOptions
        .filter(
          (option) =>
            option.entity_type === definition.entity_type && option.field_key === definition.key,
        )
        .map((option) => ({ value: option.value, label: option.value })),
    }))

  return [...baseFieldsFor(entity), ...custom]
}

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  starts_with: 'starts with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  in: 'is any of',
  has_all: 'includes all of',
  has_any: 'includes any of',
  has_none: 'includes none of',
  is_exactly: 'is exactly',
}

export function operatorsFor(type: FieldDef['type']): FilterOperator[] {
  switch (type) {
    case 'number':
    case 'date':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty']
    case 'enum':
    case 'uuid':
      return ['eq', 'neq', 'in', 'is_empty', 'is_not_empty']
    case 'array':
      return ['has_all', 'has_any', 'has_none', 'is_exactly', 'is_empty', 'is_not_empty']
    case 'boolean':
      return ['eq']
    default:
      return ['contains', 'eq', 'neq', 'starts_with', 'is_empty', 'is_not_empty']
  }
}

/**
 * `custom_fields.tier` addresses a JSON key; PostgREST spells that
 * `custom_fields->>tier`.
 */
export function toColumn(field: string): string {
  if (field.startsWith('custom_fields.')) {
    return `custom_fields->>${field.slice('custom_fields.'.length)}`
  }
  return field
}

/** Values inside an `or=(...)` list need quoting when they contain separators. */
export function escapeValue(value: unknown): string {
  const raw = String(value ?? '')
  if (/[,.()"\s:]/.test(raw)) {
    return `"${raw.replace(/"/g, '\\"')}"`
  }
  return raw
}

/** A comma-separated string or an array, either way a list of trimmed values. */
function toList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(',')
        .map((item) => item.trim())
  return raw.map((item) => String(item).trim()).filter(Boolean)
}

export interface Predicate {
  /** PostgREST filter string, e.g. `lead_score.gte.10`. */
  expression: string
}

export function conditionToPredicate(condition: FilterCondition): Predicate | null {
  const column = toColumn(condition.field)
  const { operator, value } = condition

  switch (operator) {
    case 'is_empty':
      return { expression: `${column}.is.null` }
    case 'is_not_empty':
      return { expression: `${column}.not.is.null` }
    case 'contains':
      if (value === undefined || value === null || value === '') return null
      return { expression: `${column}.ilike.${escapeValue(`%${value}%`)}` }
    case 'starts_with':
      if (value === undefined || value === null || value === '') return null
      return { expression: `${column}.ilike.${escapeValue(`${value}%`)}` }
    /*
     * PostgREST spells array containment `cs`, overlap `ov`, and takes the list
     * in braces. An empty list is not a filter — it would either match
     * everything or nothing depending on the operator, and neither is what
     * somebody who has not finished typing meant.
     */
    case 'has_all':
    case 'has_any':
    case 'has_none':
    case 'is_exactly': {
      const list = toList(value)
      if (list.length === 0) return null
      const braced = `{${list.map((item) => `"${String(item).replace(/"/g, '\\"')}"`).join(',')}}`

      if (operator === 'has_all') return { expression: `${column}.cs.${braced}` }
      if (operator === 'has_any') return { expression: `${column}.ov.${braced}` }
      if (operator === 'has_none') return { expression: `${column}.not.ov.${braced}` }

      /*
       * Exactly these and no others. Sound only because the column is stored
       * sorted and de-duplicated — otherwise {CA,US} and {US,CA} would be
       * different territories, which is not a distinction anybody means.
       */
      return { expression: `${column}.eq.${braced}` }
    }
    case 'in': {
      const list = Array.isArray(value)
        ? value
        : String(value ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
      if (list.length === 0) return null
      return { expression: `${column}.in.(${list.map(escapeValue).join(',')})` }
    }
    default:
      if (value === undefined || value === null || value === '') return null
      return { expression: `${column}.${operator}.${escapeValue(value)}` }
  }
}

/**
 * Free-text search across an entity's obvious text columns. Kept separate from
 * conditions so a saved filter can carry both.
 */
export function searchPredicate(entity: FilterEntityType, term: string): string | null {
  const trimmed = term.trim()
  if (!trimmed) return null

  const columns = searchColumnsFor(entity)

  return columns.map((c) => `${c}.ilike.${escapeValue(`%${trimmed}%`)}`).join(',')
}

/**
 * The obvious text columns per entity, in one table so the query path and the
 * in-memory path cannot drift into searching different things.
 */
const SEARCH_COLUMNS: Partial<Record<FilterEntityType, string[]>> = {
  contact: ['first_name', 'last_name', 'email', 'phone'],
  company: ['name', 'domain', 'industry'],
  deal: ['name'],
  product: ['name', 'sku', 'brand'],
  marketplace: ['name', 'domain', 'marketplace_profiles.store_name'],
}

const searchColumnsFor = (entity: FilterEntityType): string[] =>
  SEARCH_COLUMNS[entity] ?? SEARCH_COLUMNS.contact!

/** Minimal shape of the PostgREST builder this module needs. */
export interface QueryLike {
  or(filters: string): QueryLike
  filter(column: string, operator: string, value: unknown): QueryLike
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): QueryLike
}

/**
 * Applies a saved filter to an already organization-scoped query.
 *
 * Never call this on an unscoped builder: it deliberately knows nothing about
 * tenancy, and `scoped()` is what supplies it.
 */
export function applyFilter<T extends QueryLike>(
  query: T,
  config: FilterConfig,
  entity: FilterEntityType = 'contact',
  /*
   * What to order by when nobody has chosen. Newest first is right for a list
   * of people or deals, where the question is usually "what has happened
   * lately"; it is wrong for a catalogue, which is read alphabetically. The
   * caller knows which of the two it is.
   */
  defaultOrder: { column: string; ascending: boolean } = { column: 'created_at', ascending: false },
): T {
  let result = query

  const predicates = config.conditions
    .map(conditionToPredicate)
    .filter((p): p is Predicate => p !== null)

  if (config.match === 'any' && predicates.length > 0) {
    result = result.or(predicates.map((p) => p.expression).join(',')) as T
  } else {
    for (const predicate of predicates) {
      // `filter()` takes the parts separately; splitting on the first two dots
      // preserves values that themselves contain dots.
      const firstDot = predicate.expression.indexOf('.')
      const column = predicate.expression.slice(0, firstDot)
      const rest = predicate.expression.slice(firstDot + 1)
      const secondDot = rest.indexOf('.')
      const [operator, value] =
        rest.startsWith('not.is.')
          ? ['not.is', rest.slice('not.is.'.length)]
          : [rest.slice(0, secondDot), rest.slice(secondDot + 1)]

      const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
      result = result.filter(column, operator, operator === 'in' ? value : unquoted) as T
    }
  }

  const search = config.search ? searchPredicate(entity, config.search) : null
  if (search) {
    result = result.or(search) as T
  }

  if (config.sort) {
    result = result.order(toColumn(config.sort.field), {
      ascending: config.sort.direction === 'asc',
      nullsFirst: false,
    }) as T
  } else {
    result = result.order(defaultOrder.column, { ascending: defaultOrder.ascending }) as T
  }

  return result
}

export interface RowGroup<T> {
  key: string | null
  label: string
  rows: T[]
  /** Present only when a second level was asked for. */
  subGroups?: RowGroup<T>[]
}

/**
 * One row's value for a group field.
 *
 * A dotted key walks into the row rather than naming a column, which covers
 * both of the shapes that need it: `custom_fields.condition` reaching into the
 * jsonb every entity carries, and `marketplace_profiles.selling_cost` reaching
 * into an embedded row, where the marketplaces list joins a company to its
 * profile and the thing worth grouping by lives on the profile.
 */
function groupValue(row: Record<string, unknown>, field: string): string | null {
  const raw = rowValue(row, field)
  return raw === null || raw === undefined || raw === '' ? null : String(raw)
}

/** The same walk, returning what is actually there rather than a label. */
function rowValue(row: Record<string, unknown>, field: string): unknown {
  let raw: unknown = row

  for (const step of field.split('.')) {
    if (raw === null || raw === undefined || typeof raw !== 'object') return null
    raw = (raw as Record<string, unknown>)[step]
  }

  return raw ?? null
}

/**
 * Buckets rows by one field.
 *
 * Alphabetical, with the empty bucket last: "None" is a bucket of things that
 * need attention rather than a name, and it belongs at the bottom of the page
 * rather than sorted under N.
 */
export function groupRows<T extends Record<string, unknown>>(
  rows: T[],
  groupBy: string | null | undefined,
  labelFor: (value: string | null) => string = (v) => v ?? '—',
): RowGroup<T>[] {
  if (!groupBy) return [{ key: null, label: 'All', rows }]

  const buckets = new Map<string | null, T[]>()

  for (const row of rows) {
    const key = groupValue(row, groupBy)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }

  return [...buckets.entries()]
    .map(([key, groupedRows]) => ({ key, label: labelFor(key), rows: groupedRows }))
    .sort((a, b) => {
      if (a.key === null) return 1
      if (b.key === null) return -1
      return a.label.localeCompare(b.label)
    })
}

/**
 * The same, twice: owner, then priority inside each owner.
 *
 * Two levels rather than n. Three would be a tree, and a tree of a list is a
 * report — at that point the answer is a saved view per branch, not more
 * nesting on a screen somebody is trying to scan.
 *
 * `labelFor` takes the field as well as the value, because the two levels are
 * different fields and an owner id and a stage id both look like a uuid.
 * Grouping by the same field twice is treated as one level: the sub-groups
 * would each hold exactly the group above them, which is furniture.
 */
/**
 * Group headings read off the field list the filter is already using.
 *
 * Every field that stores something other than what it shows already carries
 * the mapping, because the filter needs the same list to offer a condition: an
 * owner's uuid against a name, a country's `CA` against Canada, a lifecycle
 * stage's `lead` against Lead. Reading the heading off that same list is what
 * stops a field being labelled correctly in one place and raw in the other,
 * which is exactly how "CA" and "lead" ended up as headings.
 *
 * Pass the same `fields` array given to the FilterBar, options and all.
 */
export function labelFromFields(
  fields: FieldDef[],
): (field: string, value: string | null) => string {
  const labels = new Map(
    fields
      .filter((field) => field.options && field.options.length > 0)
      .map((field) => [
        field.key,
        new Map(field.options!.map((option) => [option.value, option.label])),
      ]),
  )
  const types = new Map(fields.map((field) => [field.key, field.type]))

  return (field, value) => {
    if (value === null) return 'None'

    const label = labels.get(field)?.get(value)
    if (label) return label

    /*
     * An unresolved uuid says nothing at all to a reader, so it becomes a
     * word. Anything else is a code or a stored word, and reads better as
     * itself than as "Unknown" — a value that is present but unrecognised
     * should look slightly wrong rather than absent.
     */
    return types.get(field) === 'uuid' ? 'Unknown' : value
  }
}

export function groupRowsNested<T extends Record<string, unknown>>(
  rows: T[],
  groupBy: string | null | undefined,
  subGroupBy: string | null | undefined,
  labelFor: (field: string, value: string | null) => string = (_f, v) => v ?? '—',
): RowGroup<T>[] {
  const top = groupRows(rows, groupBy, (value) => labelFor(groupBy ?? '', value))

  if (!groupBy || !subGroupBy || subGroupBy === groupBy) return top

  return top.map((group) => ({
    ...group,
    subGroups: groupRows(group.rows, subGroupBy, (value) => labelFor(subGroupBy, value)),
  }))
}

// -----------------------------------------------------------------------------
// The same filter, evaluated in memory
//
// For lists whose interesting columns are not columns of the table being
// queried. The marketplaces list is a company joined to its profile, and half
// of what anybody wants to filter on — what it costs, how it pays, whether
// there is a buyer's premium — lives on the profile.
//
// Everything below is written to agree with conditionToPredicate rather than to
// be independently reasonable, because the same FilterBar drives both and a
// condition that means one thing on Products and another on Marketplaces would
// be worse than no filter at all. Where SQL and intuition disagree, SQL wins:
// `is not` does not match a row with no value, because `col <> 'x'` is null for
// a null column and null is not true.
// -----------------------------------------------------------------------------

function isBlank(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === '') return true
  return Array.isArray(raw) && raw.length === 0
}

const text = (value: unknown) => String(value ?? '').toLowerCase()

/** Numeric where both sides are numbers, lexicographic otherwise — which is */
/** the right answer for ISO dates and the only sane one for everything else. */
function compare(raw: unknown, value: unknown): number {
  const a = Number(raw)
  const b = Number(value)
  if (Number.isFinite(a) && Number.isFinite(b) && String(raw).trim() !== '') return a - b

  const left = String(raw ?? '')
  const right = String(value ?? '')
  return left < right ? -1 : left > right ? 1 : 0
}

function matchesCondition(row: Record<string, unknown>, condition: FilterCondition): boolean {
  const raw = rowValue(row, condition.field)
  const { operator, value } = condition

  if (operator === 'is_empty') return isBlank(raw)
  if (operator === 'is_not_empty') return !isBlank(raw)

  // Nothing to compare against is not a match, whichever way the comparison
  // was going to run. See the note above about `is not`.
  if (isBlank(raw)) return false

  const list = Array.isArray(value)
    ? value.map(String)
    : String(value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)

  const asArray = Array.isArray(raw) ? raw.map(String) : [String(raw)]

  switch (operator) {
    case 'eq':
      return String(raw) === String(value)
    case 'neq':
      return String(raw) !== String(value)
    case 'contains':
      return text(raw).includes(text(value))
    case 'starts_with':
      return text(raw).startsWith(text(value))
    case 'gt':
      return compare(raw, value) > 0
    case 'gte':
      return compare(raw, value) >= 0
    case 'lt':
      return compare(raw, value) < 0
    case 'lte':
      return compare(raw, value) <= 0
    case 'in':
      return list.length > 0 && list.includes(String(raw))
    case 'has_all':
      return list.length > 0 && list.every((item) => asArray.includes(item))
    case 'has_any':
      return list.length > 0 && list.some((item) => asArray.includes(item))
    case 'has_none':
      return list.length > 0 && !list.some((item) => asArray.includes(item))
    /*
     * Exactly these and no others. Compared as sorted sets rather than in
     * order, because the stored array is kept sorted and de-duplicated by a
     * trigger and the typed list is whatever order somebody typed it in.
     */
    case 'is_exactly': {
      if (list.length === 0) return false
      const a = [...new Set(asArray)].sort()
      const b = [...new Set(list)].sort()
      return a.length === b.length && a.every((item, index) => item === b[index])
    }
    default:
      return false
  }
}

/**
 * Whether one row satisfies a filter, conditions and free-text search alike.
 *
 * An empty condition — one somebody has added but not filled in — is skipped
 * rather than failing the row, so a half-typed filter narrows nothing instead
 * of emptying the screen. That mirrors conditionToPredicate returning null.
 */
export function matchesFilter(
  row: Record<string, unknown>,
  config: FilterConfig,
  entity: FilterEntityType,
): boolean {
  const usable = config.conditions.filter((condition) => {
    if (condition.operator === 'is_empty' || condition.operator === 'is_not_empty') return true
    if (Array.isArray(condition.value)) return condition.value.length > 0
    return condition.value !== undefined && condition.value !== null && condition.value !== ''
  })

  if (usable.length > 0) {
    const results = usable.map((condition) => matchesCondition(row, condition))
    const passes = config.match === 'any' ? results.some(Boolean) : results.every(Boolean)
    if (!passes) return false
  }

  const term = config.search?.trim().toLowerCase()
  if (!term) return true

  return searchColumnsFor(entity).some((column) => text(rowValue(row, column)).includes(term))
}

/**
 * Sorts rows the way applyFilter would have asked the database to.
 *
 * Blanks last in both directions — the same `nullsFirst: false` the query path
 * passes — because a column somebody sorted by is a column they want to read,
 * and the rows that have nothing to say about it belong at the bottom either
 * way.
 */
export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  sort: FilterConfig['sort'],
): T[] {
  if (!sort) return rows

  const direction = sort.direction === 'asc' ? 1 : -1

  return [...rows].sort((a, b) => {
    const left = rowValue(a, sort.field)
    const right = rowValue(b, sort.field)

    if (isBlank(left) && isBlank(right)) return 0
    if (isBlank(left)) return 1
    if (isBlank(right)) return -1

    return compare(left, right) * direction
  })
}

export function parseFilterConfig(value: unknown): FilterConfig {
  if (!value || typeof value !== 'object') return { ...EMPTY_FILTER }
  const raw = value as Partial<FilterConfig>
  return {
    match: raw.match === 'any' ? 'any' : 'all',
    conditions: Array.isArray(raw.conditions)
      ? raw.conditions.filter(
          (c): c is FilterCondition =>
            Boolean(c) && typeof c.field === 'string' && typeof c.operator === 'string',
        )
      : [],
    search: typeof raw.search === 'string' ? raw.search : '',
    groupBy: typeof raw.groupBy === 'string' ? raw.groupBy : null,
    subGroupBy: typeof raw.subGroupBy === 'string' ? raw.subGroupBy : null,
    sort:
      raw.sort && typeof raw.sort.field === 'string'
        ? { field: raw.sort.field, direction: raw.sort.direction === 'asc' ? 'asc' : 'desc' }
        : null,
  }
}

/** Round-trips a filter through the URL so a filtered view is shareable. */
export function filterToSearchParams(config: FilterConfig): URLSearchParams {
  const params = new URLSearchParams()
  if (config.search) params.set('q', config.search)
  if (config.groupBy) params.set('group', config.groupBy)
  // Only alongside a group. A subgroup on its own has nothing to sit inside,
  // and a stale one in a bookmarked URL would reappear the moment somebody
  // picked a group again.
  if (config.groupBy && config.subGroupBy) params.set('subgroup', config.subGroupBy)
  if (config.sort) params.set('sort', `${config.sort.field}:${config.sort.direction}`)
  if (config.match === 'any') params.set('match', 'any')
  if (config.conditions.length > 0) params.set('f', JSON.stringify(config.conditions))
  return params
}

export function filterFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): FilterConfig {
  const get = (key: string) => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }

  let conditions: FilterCondition[] = []
  const rawConditions = get('f')
  if (rawConditions) {
    try {
      const parsed = JSON.parse(rawConditions)
      if (Array.isArray(parsed)) conditions = parsed
    } catch {
      conditions = []
    }
  }

  const sortRaw = get('sort')
  const [sortField, sortDirection] = sortRaw ? sortRaw.split(':') : []

  return {
    match: get('match') === 'any' ? 'any' : 'all',
    conditions,
    search: get('q') ?? '',
    groupBy: get('group') ?? null,
    subGroupBy: get('group') ? (get('subgroup') ?? null) : null,
    sort: sortField ? { field: sortField, direction: sortDirection === 'asc' ? 'asc' : 'desc' } : null,
  }
}

// -----------------------------------------------------------------------------
// What the deal board shows
// -----------------------------------------------------------------------------

export type DealVisibility =
  | { kind: 'all' }
  | { kind: 'status'; status: string }
  | { kind: 'open-or-closing'; closingStageIds: string[] }

/**
 * How the status filter should be applied, given which view is asking.
 *
 * A board is arranged by stage, so once dragging a card into Won actually marks
 * the deal won, filtering won deals off the board makes the drop look like a
 * delete — the card vanishes and the Won column can never hold anything. On the
 * board, "Open deals" therefore means open deals plus whatever is sitting in a
 * closing stage: the column exists, and what is in it should be visible.
 *
 * The list is arranged by nothing in particular, so there "Open deals" means
 * open deals and nothing else. One filter, two honest readings.
 */
export function dealVisibility(
  status: string,
  view: 'kanban' | 'list',
  closingStageIds: string[],
): DealVisibility {
  if (status === 'all') return { kind: 'all' }

  if (status === 'open' && view === 'kanban' && closingStageIds.length > 0) {
    return { kind: 'open-or-closing', closingStageIds }
  }

  // Asking for "Won only" is a deliberate choice and is answered literally,
  // on either view.
  return { kind: 'status', status }
}
