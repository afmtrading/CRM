/**
 * The deal ledger: every deal ever recorded, on one screen.
 *
 * Everything here is pure. The database hands back one denormalised row per
 * deal (see the deal_ledger function) and this module decides what to show,
 * how to group it, and what it adds up to — which means the screen and the CSV
 * export run the same code and cannot disagree.
 *
 * Filtering and grouping happen here rather than in SQL on purpose. Half of
 * what a sales director wants to slice by — product, region — is a list on the
 * row rather than a column, and a predicate cannot express "deals in Ontario"
 * without a join that changes what a row means. In memory it is a filter over
 * a bounded set, which is both simpler and honest about the fan-out.
 */

export interface LedgerRow {
  deal_id: string
  name: string
  status: 'open' | 'won' | 'lost'
  pipeline_id: string | null
  pipeline_name: string | null
  stage_id: string | null
  stage_name: string | null
  stage_order: number | null
  owner_id: string | null
  owner_name: string | null
  closed_owner_id: string | null
  closed_owner_name: string | null
  company_id: string | null
  company_name: string | null
  contact_id: string | null
  contact_name: string | null
  value: number
  currency: string
  probability: number
  weighted_value: number
  /** Null when the deal has no line items: unknown, not zero. */
  revenue: number | null
  cost: number | null
  margin: number | null
  line_count: number
  /** Lines with a cost actually recorded. Fewer than line_count means the margin is optimistic. */
  costed_lines: number
  created_at: string
  expected_close_date: string | null
  actual_close_date: string | null
  closed_at: string | null
  loss_reason: string | null
  /** Days from created to closed. Null while the deal is still open. */
  cycle_days: number | null
  products: string[]
  regions: string[]
}

// -----------------------------------------------------------------------------
// Columns
// -----------------------------------------------------------------------------

export type LedgerColumnKey =
  | 'name'
  | 'status'
  | 'pipeline_name'
  | 'stage_name'
  | 'owner_name'
  | 'company_name'
  | 'contact_name'
  | 'value'
  | 'weighted_value'
  | 'margin'
  | 'products'
  | 'regions'
  | 'created_at'
  | 'expected_close_date'
  | 'actual_close_date'
  | 'cycle_days'
  | 'loss_reason'
  | 'currency'

export interface LedgerColumn {
  key: LedgerColumnKey
  label: string
  /** How the value is rendered and sorted. */
  kind: 'text' | 'money' | 'number' | 'date' | 'list' | 'status'
  groupable: boolean
  /** A value on this row may belong to several groups at once. */
  multi?: boolean
  numeric?: boolean
}

/**
 * The ledger's columns, in the order they were asked for, with Owner added.
 *
 * Owner is not on the original list and is the reason the ledger exists — every
 * question in the plan below it is per-owner. Currency is here because a total
 * without one is not a number.
 */
export const LEDGER_COLUMNS: LedgerColumn[] = [
  { key: 'name', label: 'Deal', kind: 'text', groupable: false },
  { key: 'status', label: 'Status', kind: 'status', groupable: true },
  { key: 'owner_name', label: 'Owner', kind: 'text', groupable: true },
  { key: 'pipeline_name', label: 'Pipeline', kind: 'text', groupable: true },
  { key: 'stage_name', label: 'Stage', kind: 'text', groupable: true },
  { key: 'value', label: 'Value', kind: 'money', groupable: false, numeric: true },
  { key: 'weighted_value', label: 'Weighted', kind: 'money', groupable: false, numeric: true },
  { key: 'margin', label: 'Margin', kind: 'money', groupable: false, numeric: true },
  { key: 'company_name', label: 'Company', kind: 'text', groupable: true },
  { key: 'contact_name', label: 'Contact', kind: 'text', groupable: true },
  { key: 'created_at', label: 'Initiated', kind: 'date', groupable: false },
  { key: 'expected_close_date', label: 'Expected close', kind: 'date', groupable: false },
  { key: 'actual_close_date', label: 'Actual close', kind: 'date', groupable: false },
  { key: 'cycle_days', label: 'Days to close', kind: 'number', groupable: false, numeric: true },
  { key: 'products', label: 'Product', kind: 'list', groupable: true, multi: true },
  { key: 'regions', label: 'Region', kind: 'list', groupable: true, multi: true },
  { key: 'loss_reason', label: 'Loss reason', kind: 'text', groupable: true },
  { key: 'currency', label: 'Currency', kind: 'text', groupable: true },
]

export const GROUPABLE_COLUMNS = LEDGER_COLUMNS.filter((column) => column.groupable)

export function columnFor(key: string): LedgerColumn | undefined {
  return LEDGER_COLUMNS.find((column) => column.key === key)
}

// -----------------------------------------------------------------------------
// Filtering
// -----------------------------------------------------------------------------

/** Which date a range applies to. A ledger holds three, and they mean different things. */
export type LedgerDateField = 'created_at' | 'expected_close_date' | 'actual_close_date'

export const DATE_FIELDS: { key: LedgerDateField; label: string }[] = [
  { key: 'created_at', label: 'Initiated' },
  { key: 'expected_close_date', label: 'Expected close' },
  { key: 'actual_close_date', label: 'Actual close' },
]

export interface LedgerFilter {
  /** 'all' by default — a ledger that hides closed deals is not a ledger. */
  status: 'all' | 'open' | 'won' | 'lost'
  pipeline: string
  owner: string
  company: string
  product: string
  region: string
  lossReason: string
  dateField: LedgerDateField
  from: string
  to: string
  search: string
}

export const EMPTY_LEDGER_FILTER: LedgerFilter = {
  status: 'all',
  pipeline: '',
  owner: '',
  company: '',
  product: '',
  region: '',
  lossReason: '',
  dateField: 'created_at',
  from: '',
  to: '',
  search: '',
}

type ParamBag = Record<string, string | string[] | undefined>

function one(params: ParamBag, key: string): string {
  const value = params[key]
  const raw = Array.isArray(value) ? value[0] : value
  return (raw ?? '').trim()
}

export function ledgerFilterFromParams(params: ParamBag): LedgerFilter {
  const status = one(params, 'status')
  const dateField = one(params, 'date')

  return {
    status:
      status === 'open' || status === 'won' || status === 'lost' ? status : 'all',
    pipeline: one(params, 'pipeline'),
    owner: one(params, 'owner'),
    company: one(params, 'company'),
    product: one(params, 'product'),
    region: one(params, 'region'),
    lossReason: one(params, 'reason'),
    dateField: DATE_FIELDS.some((field) => field.key === dateField)
      ? (dateField as LedgerDateField)
      : 'created_at',
    from: one(params, 'from'),
    to: one(params, 'to'),
    search: one(params, 'q'),
  }
}

/** The filter as a query string, so a filtered ledger is a link somebody can send. */
export function ledgerFilterToParams(filter: LedgerFilter): URLSearchParams {
  const params = new URLSearchParams()
  if (filter.status !== 'all') params.set('status', filter.status)
  if (filter.pipeline) params.set('pipeline', filter.pipeline)
  if (filter.owner) params.set('owner', filter.owner)
  if (filter.company) params.set('company', filter.company)
  if (filter.product) params.set('product', filter.product)
  if (filter.region) params.set('region', filter.region)
  if (filter.lossReason) params.set('reason', filter.lossReason)
  if (filter.dateField !== 'created_at') params.set('date', filter.dateField)
  if (filter.from) params.set('from', filter.from)
  if (filter.to) params.set('to', filter.to)
  if (filter.search) params.set('q', filter.search)
  return params
}

export function isFiltered(filter: LedgerFilter): boolean {
  return ledgerFilterToParams(filter).toString().length > 0
}

/**
 * A date column compared against a range.
 *
 * Both ends are inclusive, and a row with no date at all fails a range rather
 * than passing it: "closed in March" cannot be true of a deal that never
 * closed.
 */
function withinRange(value: string | null, from: string, to: string): boolean {
  if (!from && !to) return true
  if (!value) return false

  const day = value.slice(0, 10)
  if (from && day < from) return false
  if (to && day > to) return false
  return true
}

export function matchesLedgerFilter(row: LedgerRow, filter: LedgerFilter): boolean {
  if (filter.status !== 'all' && row.status !== filter.status) return false
  if (filter.pipeline && row.pipeline_id !== filter.pipeline) return false
  if (filter.owner && row.owner_id !== filter.owner) return false
  if (filter.company && row.company_id !== filter.company) return false
  if (filter.product && !row.products.includes(filter.product)) return false
  if (filter.region && !row.regions.includes(filter.region)) return false
  if (filter.lossReason && row.loss_reason !== filter.lossReason) return false

  if (!withinRange(row[filter.dateField], filter.from, filter.to)) return false

  if (filter.search) {
    const needle = filter.search.toLowerCase()
    const haystack = [
      row.name,
      row.company_name,
      row.contact_name,
      row.owner_name,
      row.loss_reason,
      ...row.products,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!haystack.includes(needle)) return false
  }

  return true
}

export function applyLedgerFilter(rows: LedgerRow[], filter: LedgerFilter): LedgerRow[] {
  return rows.filter((row) => matchesLedgerFilter(row, filter))
}

// -----------------------------------------------------------------------------
// Sorting
// -----------------------------------------------------------------------------

export interface LedgerSort {
  key: LedgerColumnKey
  direction: 'asc' | 'desc'
}

export function parseSort(raw: string | undefined): LedgerSort {
  const [key, direction] = (raw ?? '').split(':')
  if (columnFor(key)) {
    return { key: key as LedgerColumnKey, direction: direction === 'asc' ? 'asc' : 'desc' }
  }
  // Newest first: a ledger is read from the top, and the top is what just happened.
  return { key: 'created_at', direction: 'desc' }
}

function sortValue(row: LedgerRow, key: LedgerColumnKey): string | number | null {
  const raw = row[key as keyof LedgerRow]
  if (Array.isArray(raw)) return raw.length > 0 ? raw.join(', ').toLowerCase() : null
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') return raw.toLowerCase()
  return null
}

/**
 * Sorts a copy, nulls always last.
 *
 * Nulls sink in both directions on purpose: "sort by margin" should put the
 * biggest margin at the top, not a wall of deals whose margin is unknown.
 */
export function sortLedger(rows: LedgerRow[], sort: LedgerSort): LedgerRow[] {
  const factor = sort.direction === 'asc' ? 1 : -1

  return [...rows].sort((a, b) => {
    const left = sortValue(a, sort.key)
    const right = sortValue(b, sort.key)

    if (left === null && right === null) return 0
    if (left === null) return 1
    if (right === null) return -1

    if (typeof left === 'number' && typeof right === 'number') {
      return (left - right) * factor
    }
    return String(left).localeCompare(String(right)) * factor
  })
}

// -----------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------

export interface LedgerGroup {
  key: string | null
  label: string
  rows: LedgerRow[]
}

/** The values one row contributes to a grouping. Usually one; sometimes several. */
export function groupValues(row: LedgerRow, key: LedgerColumnKey): (string | null)[] {
  const raw = row[key as keyof LedgerRow]

  if (Array.isArray(raw)) {
    return raw.length === 0 ? [null] : raw
  }
  if (raw === null || raw === undefined || raw === '') return [null]
  return [String(raw)]
}

/**
 * Buckets rows for the grouped view.
 *
 * Product and region are lists, so a deal for two products lands in both
 * groups. That is the useful answer to "how are we doing in Ontario" and it
 * does mean the group subtotals add up to more than the ledger total — which
 * the screen says out loud rather than leaving to be discovered.
 */
export function groupLedger(rows: LedgerRow[], groupBy: LedgerColumnKey | null): LedgerGroup[] {
  if (!groupBy) return [{ key: null, label: 'All deals', rows }]

  const buckets = new Map<string | null, LedgerRow[]>()

  for (const row of rows) {
    for (const value of groupValues(row, groupBy)) {
      const bucket = buckets.get(value)
      if (bucket) bucket.push(row)
      else buckets.set(value, [row])
    }
  }

  return [...buckets.entries()]
    .map(([key, groupRows]) => ({ key, label: key ?? 'Not set', rows: groupRows }))
    .sort((a, b) => {
      // "Not set" last, everything else alphabetically.
      if (a.key === null) return 1
      if (b.key === null) return -1
      return a.label.localeCompare(b.label)
    })
}

/** True when one deal can appear in more than one group of this grouping. */
export function groupingOverlaps(groupBy: LedgerColumnKey | null): boolean {
  return Boolean(groupBy && columnFor(groupBy)?.multi)
}

// -----------------------------------------------------------------------------
// Totals
// -----------------------------------------------------------------------------

export interface MoneyAmount {
  value: number
  currency: string
}

export interface LedgerSummary {
  deals: number
  open: number
  won: number
  lost: number
  /** Won ÷ closed, by count. Null when nothing has closed — not zero. */
  winRate: number | null
  /** Median days to close over closed deals. Null when nothing has closed. */
  medianCycle: number | null
  totalValue: MoneyAmount[]
  wonValue: MoneyAmount[]
  openWeighted: MoneyAmount[]
  margin: MoneyAmount[]
  /** Deals with no line items, whose margin cannot be known. */
  marginUnknown: number
  /** Deals whose lines are missing a cost, so the margin above flatters them. */
  marginPartial: number
}

/** Sums per currency, because two currencies do not add up without a rate. */
function byCurrency(rows: { value: number; currency: string }[]): MoneyAmount[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const currency = (row.currency || '').toUpperCase()
    totals.set(currency, (totals.get(currency) ?? 0) + row.value)
  }
  return [...totals.entries()]
    .map(([currency, value]) => ({ currency, value }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle]
}

export function summariseLedger(rows: LedgerRow[]): LedgerSummary {
  const won = rows.filter((row) => row.status === 'won')
  const lost = rows.filter((row) => row.status === 'lost')
  const open = rows.filter((row) => row.status === 'open')
  const closed = won.length + lost.length

  const withMargin = rows.filter((row) => row.margin !== null)

  return {
    deals: rows.length,
    open: open.length,
    won: won.length,
    lost: lost.length,
    // A win rate over nothing is not 0%, it is unanswerable.
    winRate: closed === 0 ? null : won.length / closed,
    medianCycle: median(
      rows
        .filter((row) => row.cycle_days !== null)
        .map((row) => row.cycle_days as number),
    ),
    totalValue: byCurrency(rows.map((row) => ({ value: row.value, currency: row.currency }))),
    wonValue: byCurrency(won.map((row) => ({ value: row.value, currency: row.currency }))),
    openWeighted: byCurrency(
      open.map((row) => ({ value: row.weighted_value, currency: row.currency })),
    ),
    margin: byCurrency(
      withMargin.map((row) => ({ value: row.margin as number, currency: row.currency })),
    ),
    marginUnknown: rows.length - withMargin.length,
    marginPartial: rows.filter((row) => row.line_count > 0 && row.costed_lines < row.line_count)
      .length,
  }
}

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

/**
 * One ledger row as flat columns for CSV.
 *
 * Lists are joined rather than repeated, so a spreadsheet keeps one line per
 * deal and the file's row count matches the screen's deal count.
 */
export function ledgerCsvRow(row: LedgerRow): Record<string, string | number | null> {
  return {
    Deal: row.name,
    Status: row.status,
    Owner: row.owner_name ?? '',
    'Closed by owner': row.closed_owner_name ?? '',
    Pipeline: row.pipeline_name ?? '',
    Stage: row.stage_name ?? '',
    Value: row.value,
    Currency: row.currency,
    Probability: row.probability,
    Weighted: row.weighted_value,
    Revenue: row.revenue,
    Cost: row.cost,
    Margin: row.margin,
    'Line items': row.line_count,
    Company: row.company_name ?? '',
    Contact: row.contact_name ?? '',
    Initiated: row.created_at.slice(0, 10),
    'Expected close': row.expected_close_date ?? '',
    'Actual close': row.actual_close_date ?? '',
    'Days to close': row.cycle_days,
    'Loss reason': row.loss_reason ?? '',
    Product: row.products.join(', '),
    Region: row.regions.join(', '),
  }
}

// -----------------------------------------------------------------------------
// Which company field is "Region"
// -----------------------------------------------------------------------------

/**
 * Finds the company field an organization uses for region.
 *
 * Region is not a column anywhere: it is an organization-defined field, and
 * this one is called "Regions" on the Company Rating card. Matched by label
 * rather than key so it survives being renamed to "Territory" — and returns
 * null rather than guessing when there is nothing that looks like one, which
 * makes the Region column simply not appear.
 */
export function regionFieldKey(
  definitions: { entity_type: string; key: string; label: string; field_type: string }[],
): string | null {
  const candidates = definitions.filter(
    (definition) =>
      definition.entity_type === 'company' &&
      (definition.field_type === 'select' || definition.field_type === 'multiselect'),
  )

  const match =
    candidates.find((definition) => /^regions?$/i.test(definition.label.trim())) ??
    candidates.find((definition) => /region|territory/i.test(definition.label))

  return match?.key ?? null
}
