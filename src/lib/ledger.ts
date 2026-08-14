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
  /**
   * created_at as a calendar day in the organization's timezone, resolved by
   * deal_ledger. This is the one to compare, group and print — slicing the
   * first ten characters off created_at buckets by UTC, which files a deal
   * raised at 8pm in Toronto under the following day.
   */
  created_day: string
  expected_close_date: string | null
  actual_close_date: string | null
  closed_at: string | null
  /** closed_at, resolved the same way. Null while the deal is open. */
  closed_day: string | null
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
  | 'closed_owner_name'
  | 'company_name'
  | 'contact_name'
  | 'value'
  | 'weighted_value'
  | 'probability'
  | 'revenue'
  | 'cost'
  | 'margin'
  | 'line_count'
  | 'products'
  | 'regions'
  | 'created_day'
  | 'expected_close_date'
  | 'actual_close_date'
  | 'cycle_days'
  | 'loss_reason'
  | 'currency'

export interface LedgerColumn {
  key: LedgerColumnKey
  label: string
  /** How the value is rendered and sorted. */
  kind: 'text' | 'money' | 'number' | 'percent' | 'date' | 'list' | 'status'
  groupable: boolean
  /** A value on this row may belong to several groups at once. */
  multi?: boolean
  numeric?: boolean
  /**
   * Available in the picker, but not on screen until somebody asks for it.
   *
   * The ledger is already eighteen columns wide. These are the workings behind
   * columns that are shown — revenue and cost behind margin, line items behind
   * both, probability behind Weighted — and a reader who wants to check a number
   * wants them, while a reader reading the report does not. Off by default is
   * how both get what they want.
   */
  offByDefault?: boolean
}

/**
 * The ledger's columns, in the order they were asked for, with Owner added.
 *
 * Owner is not on the original list and is the reason the ledger exists — every
 * question in the plan below it is per-owner. Currency is here because a total
 * without one is not a number.
 *
 * Each column sits next to the one it explains rather than at the end, so a
 * reader who switches on Cost finds it beside Margin instead of hunting for it.
 */
export const LEDGER_COLUMNS: LedgerColumn[] = [
  { key: 'name', label: 'Deal', kind: 'text', groupable: false },
  { key: 'status', label: 'Status', kind: 'status', groupable: true },
  { key: 'owner_name', label: 'Owner', kind: 'text', groupable: true },
  // Who the deal counted for when it closed — what the performance report
  // credits. Groupable for the same reason: "who actually closed these".
  {
    key: 'closed_owner_name',
    label: 'Owner at close',
    kind: 'text',
    groupable: true,
    offByDefault: true,
  },
  { key: 'pipeline_name', label: 'Pipeline', kind: 'text', groupable: true },
  { key: 'stage_name', label: 'Stage', kind: 'text', groupable: true },
  { key: 'value', label: 'Value', kind: 'money', groupable: false, numeric: true },
  { key: 'weighted_value', label: 'Weighted', kind: 'money', groupable: false, numeric: true },
  {
    key: 'probability',
    label: 'Probability',
    kind: 'percent',
    groupable: false,
    numeric: true,
    offByDefault: true,
  },
  {
    key: 'revenue',
    label: 'Revenue',
    kind: 'money',
    groupable: false,
    numeric: true,
    offByDefault: true,
  },
  {
    key: 'cost',
    label: 'Cost',
    kind: 'money',
    groupable: false,
    numeric: true,
    offByDefault: true,
  },
  { key: 'margin', label: 'Margin', kind: 'money', groupable: false, numeric: true },
  {
    key: 'line_count',
    label: 'Line items',
    kind: 'number',
    groupable: false,
    numeric: true,
    offByDefault: true,
  },
  { key: 'company_name', label: 'Company', kind: 'text', groupable: true },
  { key: 'contact_name', label: 'Contact', kind: 'text', groupable: true },
  { key: 'created_day', label: 'Initiated', kind: 'date', groupable: false },
  { key: 'expected_close_date', label: 'Expected close', kind: 'date', groupable: false },
  { key: 'actual_close_date', label: 'Actual close', kind: 'date', groupable: false },
  { key: 'cycle_days', label: 'Days to close', kind: 'number', groupable: false, numeric: true },
  { key: 'products', label: 'Product', kind: 'list', groupable: true, multi: true },
  { key: 'regions', label: 'Region', kind: 'list', groupable: true, multi: true },
  { key: 'loss_reason', label: 'Loss reason', kind: 'text', groupable: true },
  { key: 'currency', label: 'Currency', kind: 'text', groupable: true },
]

export const GROUPABLE_COLUMNS = LEDGER_COLUMNS.filter((column) => column.groupable)

/**
 * What a ledger shows when nobody has said otherwise.
 *
 * Derived rather than listed, so a column is added in one place. The columns
 * marked off by default are still offered by the picker — see hiddenColumns —
 * they just do not widen the table for somebody who never asked for them.
 */
export const DEFAULT_COLUMNS: LedgerColumnKey[] = LEDGER_COLUMNS.filter(
  (column) => !column.offByDefault,
).map((column) => column.key)

/**
 * Where a chosen layout is remembered.
 *
 * A cookie rather than the URL alone, because the nav link to the ledger has no
 * query on it: without somewhere to remember, a chosen set of columns would be
 * thrown away every time somebody clicked Reports. The URL still wins when it
 * carries one, so a link to a particular view is still a link to that view.
 */
export const LEDGER_COLUMNS_COOKIE = 'flo.ledger.columns'

export function columnFor(key: string): LedgerColumn | undefined {
  return LEDGER_COLUMNS.find((column) => column.key === key)
}

/**
 * Reads a stored column layout.
 *
 * Unknown keys and duplicates are dropped rather than rejected: the value comes
 * from a URL or a cookie that may have been written by an older version of this
 * page, and a column that has since been renamed should cost the reader one
 * column, not the whole layout. Null means "nothing usable here" — the caller
 * then falls back rather than rendering a table with no columns in it.
 */
export function parseColumns(raw: string | null | undefined): LedgerColumnKey[] | null {
  if (!raw) return null

  const seen = new Set<string>()
  const keys: LedgerColumnKey[] = []

  for (const part of raw.split(',')) {
    const key = part.trim()
    if (!key || seen.has(key) || !columnFor(key)) continue
    seen.add(key)
    keys.push(key as LedgerColumnKey)
  }

  return keys.length > 0 ? keys : null
}

export function columnsParam(keys: LedgerColumnKey[]): string {
  return keys.join(',')
}

/** True when this layout is the default one, so the screen can say so. */
export function isDefaultColumns(keys: LedgerColumnKey[]): boolean {
  return columnsParam(keys) === columnsParam(DEFAULT_COLUMNS)
}

/**
 * The columns to draw, resolved to their definitions.
 *
 * Region is dropped when the organization keeps no region field, whatever the
 * layout says — a column that can only ever be empty is worse than one missing.
 */
export function resolveColumns(
  chosen: LedgerColumnKey[] | null,
  hasRegionField: boolean,
): LedgerColumn[] {
  return (chosen ?? DEFAULT_COLUMNS)
    .map((key) => columnFor(key))
    .filter((column): column is LedgerColumn => Boolean(column))
    .filter((column) => column.key !== 'regions' || hasRegionField)
}

/** The columns not currently shown, in their natural order, for the picker. */
export function hiddenColumns(chosen: LedgerColumnKey[]): LedgerColumn[] {
  const shown = new Set<string>(chosen)
  return LEDGER_COLUMNS.filter((column) => !shown.has(column.key))
}

/**
 * Moves one column a single place, for the picker's arrows.
 *
 * Returns the list unchanged at either end rather than wrapping around: an
 * arrow that silently sends the first column to the bottom is a surprise, and
 * the button is disabled there anyway.
 */
export function moveColumn(
  keys: LedgerColumnKey[],
  key: LedgerColumnKey,
  direction: -1 | 1,
): LedgerColumnKey[] {
  const from = keys.indexOf(key)
  if (from === -1) return keys

  const to = from + direction
  if (to < 0 || to >= keys.length) return keys

  const next = [...keys]
  next[from] = next[to]
  next[to] = key
  return next
}

// -----------------------------------------------------------------------------
// Filtering
// -----------------------------------------------------------------------------

/** Which date a range applies to. A ledger holds three, and they mean different things. */
export type LedgerDateField = 'created_day' | 'expected_close_date' | 'actual_close_date'

export const DATE_FIELDS: { key: LedgerDateField; label: string }[] = [
  { key: 'created_day', label: 'Initiated' },
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
  dateField: 'created_day',
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
    /*
     * Anything unrecognised falls back to the initiated day — including the
     * old 'created_at', so a link shared before days were resolved in the
     * organization's zone still opens the view it named.
     */
    dateField: DATE_FIELDS.some((field) => field.key === dateField)
      ? (dateField as LedgerDateField)
      : 'created_day',
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
  if (filter.dateField !== 'created_day') params.set('date', filter.dateField)
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

  // Every field a range can apply to is already a calendar day — a date column
  // straight from the table, or one deal_ledger resolved in the organization's
  // zone. Nothing here re-derives a day from an instant.
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
  return { key: 'created_day', direction: 'desc' }
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
 * One cell of the export: the plain value behind a column.
 *
 * Money comes out as a bare number rather than the "$1,200 USD" the screen
 * shows, because a spreadsheet should be able to total the column. The currency
 * travels in its own column — see exportColumns, which refuses to let a money
 * column leave without one.
 *
 * A null stays a null. An unknown margin is written as an empty cell, not a
 * zero, for the same reason the screen writes "unknown".
 */
export function ledgerCsvValue(row: LedgerRow, key: LedgerColumnKey): string | number | null {
  switch (key) {
    case 'name':
      return row.name
    case 'status':
      return row.status
    case 'owner_name':
      return row.owner_name ?? ''
    case 'closed_owner_name':
      return row.closed_owner_name ?? ''
    case 'pipeline_name':
      return row.pipeline_name ?? ''
    case 'stage_name':
      return row.stage_name ?? ''
    case 'company_name':
      return row.company_name ?? ''
    case 'contact_name':
      return row.contact_name ?? ''
    case 'value':
      return row.value
    case 'weighted_value':
      return row.weighted_value
    /*
     * The fraction as stored, not the 35 the screen prints. A spreadsheet
     * formats 0.35 as a percentage; it cannot get back to a fraction from 35
     * without knowing that column was scaled on the way out.
     */
    case 'probability':
      return row.probability
    // Null when the deal has no line items, and an empty cell is the honest
    // way to write "we do not know", exactly as with margin.
    case 'revenue':
      return row.revenue
    case 'cost':
      return row.cost
    case 'line_count':
      return row.line_count
    case 'margin':
      return row.margin
    case 'currency':
      return row.currency
    case 'created_day':
      return row.created_day
    case 'expected_close_date':
      return row.expected_close_date ?? ''
    case 'actual_close_date':
      return row.actual_close_date ?? ''
    case 'cycle_days':
      return row.cycle_days
    case 'loss_reason':
      return row.loss_reason ?? ''
    // Lists are joined rather than repeated, so the file keeps one line per
    // deal and its row count matches the screen's deal count.
    case 'products':
      return row.products.join(', ')
    case 'regions':
      return row.regions.join(', ')
  }
}

/**
 * The columns an export should carry, given what is on screen.
 *
 * The chosen columns, plus Currency whenever a money column is going out
 * without it. A column of bare amounts with no unit is the same wrong number
 * this app refuses to print anywhere else — two currencies in one column and
 * nothing to tell them apart — so the file keeps the unit even when the screen
 * had it inline in the cell.
 */
export function exportColumns(chosen: LedgerColumn[]): LedgerColumn[] {
  const hasMoney = chosen.some((column) => column.kind === 'money')
  const hasCurrency = chosen.some((column) => column.key === 'currency')

  if (!hasMoney || hasCurrency) return chosen

  const currency = columnFor('currency')
  return currency ? [...chosen, currency] : chosen
}

/**
 * One ledger row as flat columns for CSV, matching what the screen shows.
 *
 * Headed by the same labels the table uses, in the same order, so a file and a
 * screenshot of the report line up cell for cell.
 */
export function ledgerCsvRow(
  row: LedgerRow,
  columns: LedgerColumn[],
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {}
  for (const column of columns) out[column.label] = ledgerCsvValue(row, column.key)
  return out
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
