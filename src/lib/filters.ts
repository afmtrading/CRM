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
  sort?: { field: string; direction: 'asc' | 'desc' } | null
}

export const EMPTY_FILTER: FilterConfig = {
  match: 'all',
  conditions: [],
  search: '',
  groupBy: null,
  sort: null,
}

export interface FieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'boolean' | 'enum' | 'uuid'
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
  { key: 'owner_id', label: 'Owner', type: 'uuid', groupable: true },
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

export function baseFieldsFor(entity: FilterEntityType): FieldDef[] {
  switch (entity) {
    case 'company':
      return COMPANY_FIELDS
    case 'deal':
      return DEAL_FIELDS
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
}

export function operatorsFor(type: FieldDef['type']): FilterOperator[] {
  switch (type) {
    case 'number':
    case 'date':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty']
    case 'enum':
    case 'uuid':
      return ['eq', 'neq', 'in', 'is_empty', 'is_not_empty']
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

  const columns =
    entity === 'company'
      ? ['name', 'domain', 'industry']
      : entity === 'deal'
        ? ['name']
        : ['first_name', 'last_name', 'email', 'phone']

  return columns.map((c) => `${c}.ilike.${escapeValue(`%${trimmed}%`)}`).join(',')
}

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
    result = result.order('created_at', { ascending: false }) as T
  }

  return result
}

/** Groups already-fetched rows for the grouped list view. */
export function groupRows<T extends Record<string, unknown>>(
  rows: T[],
  groupBy: string | null | undefined,
  labelFor: (value: string | null) => string = (v) => v ?? '—',
): { key: string | null; label: string; rows: T[] }[] {
  if (!groupBy) return [{ key: null, label: 'All', rows }]

  const buckets = new Map<string | null, T[]>()

  for (const row of rows) {
    const raw = groupBy.startsWith('custom_fields.')
      ? ((row.custom_fields as Record<string, unknown> | undefined)?.[
          groupBy.slice('custom_fields.'.length)
        ] ?? null)
      : (row[groupBy] ?? null)

    const key = raw === null || raw === undefined || raw === '' ? null : String(raw)
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
    sort: sortField ? { field: sortField, direction: sortDirection === 'asc' ? 'asc' : 'desc' } : null,
  }
}
