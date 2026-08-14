import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COLUMNS,
  GROUPABLE_COLUMNS,
  LEDGER_COLUMNS,
  applyLedgerFilter,
  columnsParam,
  exportColumns,
  hiddenColumns,
  isDefaultColumns,
  moveColumn,
  parseColumns,
  resolveColumns,
  columnFor,
  groupLedger,
  groupValues,
  groupingOverlaps,
  isFiltered,
  ledgerCsvRow,
  ledgerCsvValue,
  ledgerFilterFromParams,
  ledgerFilterToParams,
  matchesLedgerFilter,
  median,
  parseSort,
  regionFieldKey,
  sortLedger,
  summariseLedger,
  type LedgerColumnKey,
  type LedgerRow,
} from '../src/lib/ledger'

function deal(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    deal_id: 'd1',
    name: 'Pallet of speakers',
    status: 'open',
    pipeline_id: 'p1',
    pipeline_name: 'Quotes',
    stage_id: 's1',
    stage_name: 'Quote',
    stage_order: 0,
    owner_id: 'u1',
    owner_name: 'Raj',
    closed_owner_id: null,
    closed_owner_name: null,
    company_id: 'c1',
    company_name: 'ACME',
    contact_id: 'ct1',
    contact_name: 'Dana Reed',
    value: 1000,
    currency: 'USD',
    probability: 0.5,
    weighted_value: 500,
    revenue: null,
    cost: null,
    margin: null,
    line_count: 0,
    costed_lines: 0,
    created_at: '2026-01-10T00:00:00Z',
    created_day: '2026-01-10',
    expected_close_date: '2026-03-01',
    actual_close_date: null,
    closed_at: null,
    closed_day: null,
    loss_reason: null,
    cycle_days: null,
    products: [],
    regions: [],
    ...overrides,
  }
}

describe('ledger columns', () => {
  it('offers every field that was asked for', () => {
    const labels = LEDGER_COLUMNS.map((column) => column.label)
    for (const expected of [
      'Deal',
      'Status',
      'Pipeline',
      'Stage',
      'Value',
      'Company',
      'Contact',
      'Initiated',
      'Expected close',
      'Actual close',
      'Product',
      'Region',
    ]) {
      expect(labels).toContain(expected)
    }
  })

  it('keeps weighted value and margin as separate columns', () => {
    // They answer different questions — a forecast and a real result — and the
    // report is wrong the moment one is read as the other.
    expect(columnFor('weighted_value')).toBeDefined()
    expect(columnFor('margin')).toBeDefined()
  })

  it('only offers groupings that mean something', () => {
    for (const column of GROUPABLE_COLUMNS) {
      expect(['text', 'status', 'list']).toContain(column.kind)
    }
    expect(GROUPABLE_COLUMNS.map((c) => c.key)).not.toContain('value')
  })
})

describe('filtering', () => {
  it('shows every deal by default — closed ones included', () => {
    const filter = ledgerFilterFromParams({})
    expect(filter.status).toBe('all')

    const rows = [deal({ status: 'open' }), deal({ status: 'won' }), deal({ status: 'lost' })]
    expect(applyLedgerFilter(rows, filter)).toHaveLength(3)
  })

  it('filters by a product on the deal, not a column', () => {
    const rows = [
      deal({ deal_id: 'a', products: ['Speaker', 'Cable'] }),
      deal({ deal_id: 'b', products: ['Monitor'] }),
    ]
    const filter = ledgerFilterFromParams({ product: 'Cable' })
    expect(applyLedgerFilter(rows, filter).map((r) => r.deal_id)).toEqual(['a'])
  })

  it('filters by a region carried on the company', () => {
    const rows = [
      deal({ deal_id: 'a', regions: ['Ontario'] }),
      deal({ deal_id: 'b', regions: ['Quebec', 'Ontario'] }),
      deal({ deal_id: 'c', regions: [] }),
    ]
    const filter = ledgerFilterFromParams({ region: 'Quebec' })
    expect(applyLedgerFilter(rows, filter).map((r) => r.deal_id)).toEqual(['b'])
  })

  it('applies a date range to the date that was chosen', () => {
    const row = deal({
      created_at: '2026-01-10T00:00:00Z',
      created_day: '2026-01-10',
      expected_close_date: '2026-06-01',
    })

    expect(
      matchesLedgerFilter(row, ledgerFilterFromParams({ from: '2026-01-01', to: '2026-01-31' })),
    ).toBe(true)

    expect(
      matchesLedgerFilter(
        row,
        ledgerFilterFromParams({ date: 'expected_close_date', from: '2026-01-01', to: '2026-01-31' }),
      ),
    ).toBe(false)
  })

  it('treats both ends of a range as inclusive', () => {
    const row = deal({ created_at: '2026-01-10T23:59:00Z', created_day: '2026-01-10' })
    expect(
      matchesLedgerFilter(row, ledgerFilterFromParams({ from: '2026-01-10', to: '2026-01-10' })),
    ).toBe(true)
  })

  /*
   * The case that decides whether "closed in March" can be trusted: a deal that
   * never closed has no actual close date, and must fail the range rather than
   * slip through it.
   */
  it('excludes a row with no date at all from a range', () => {
    const row = deal({ actual_close_date: null })
    expect(
      matchesLedgerFilter(
        row,
        ledgerFilterFromParams({ date: 'actual_close_date', from: '2026-03-01', to: '2026-03-31' }),
      ),
    ).toBe(false)
  })

  it('searches the deal, company, contact and products together', () => {
    const rows = [
      deal({ deal_id: 'a', name: 'Speakers', company_name: 'ACME' }),
      deal({ deal_id: 'b', name: 'Cables', company_name: 'Globex' }),
      deal({ deal_id: 'c', name: 'Monitors', products: ['Acme bracket'] }),
    ]
    const found = applyLedgerFilter(rows, ledgerFilterFromParams({ q: 'acme' }))
    expect(found.map((r) => r.deal_id)).toEqual(['a', 'c'])
  })

  it('round-trips through the URL so a view can be sent to somebody', () => {
    const filter = ledgerFilterFromParams({
      status: 'won',
      owner: 'u2',
      region: 'Ontario',
      date: 'actual_close_date',
      from: '2026-01-01',
      q: 'pallet',
    })
    expect(ledgerFilterFromParams(Object.fromEntries(ledgerFilterToParams(filter)))).toEqual(filter)
  })

  it('knows when nothing has been filtered', () => {
    expect(isFiltered(ledgerFilterFromParams({}))).toBe(false)
    expect(isFiltered(ledgerFilterFromParams({ status: 'lost' }))).toBe(true)
  })

  it('ignores a status or date field it does not recognise', () => {
    const filter = ledgerFilterFromParams({ status: 'archived', date: 'whenever' })
    expect(filter.status).toBe('all')
    expect(filter.dateField).toBe('created_day')
  })
})

describe('sorting', () => {
  it('defaults to the newest deal first', () => {
    expect(parseSort(undefined)).toEqual({ key: 'created_day', direction: 'desc' })
    expect(parseSort('nonsense:asc')).toEqual({ key: 'created_day', direction: 'desc' })
  })

  it('sorts numbers as numbers', () => {
    const rows = [deal({ deal_id: 'a', value: 90 }), deal({ deal_id: 'b', value: 1000 })]
    expect(sortLedger(rows, { key: 'value', direction: 'desc' }).map((r) => r.deal_id)).toEqual([
      'b',
      'a',
    ])
  })

  /*
   * Unknown margins sink in both directions. Sorting by margin is a question
   * about the best and worst deals, and a wall of "unknown" at the top answers
   * neither end of it.
   */
  it('keeps unknown values last whichever way it is sorted', () => {
    const rows = [
      deal({ deal_id: 'unknown', margin: null }),
      deal({ deal_id: 'low', margin: 10 }),
      deal({ deal_id: 'high', margin: 900 }),
    ]
    expect(sortLedger(rows, { key: 'margin', direction: 'desc' }).map((r) => r.deal_id)).toEqual([
      'high',
      'low',
      'unknown',
    ])
    expect(sortLedger(rows, { key: 'margin', direction: 'asc' }).map((r) => r.deal_id)).toEqual([
      'low',
      'high',
      'unknown',
    ])
  })

  it('does not modify the array it was given', () => {
    const rows = [deal({ deal_id: 'a', value: 1 }), deal({ deal_id: 'b', value: 2 })]
    sortLedger(rows, { key: 'value', direction: 'desc' })
    expect(rows.map((r) => r.deal_id)).toEqual(['a', 'b'])
  })
})

describe('grouping', () => {
  it('returns one group when nothing is grouped', () => {
    const groups = groupLedger([deal()], null)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('All deals')
  })

  it('groups by a plain column', () => {
    const rows = [
      deal({ deal_id: 'a', owner_name: 'Raj' }),
      deal({ deal_id: 'b', owner_name: 'Mo' }),
      deal({ deal_id: 'c', owner_name: 'Raj' }),
    ]
    const groups = groupLedger(rows, 'owner_name')
    expect(groups.map((g) => g.label)).toEqual(['Mo', 'Raj'])
    expect(groups[1].rows).toHaveLength(2)
  })

  /*
   * A deal for two products belongs in both groups. That is what makes "how is
   * Ontario doing" answerable, and it is why the screen says the subtotals
   * overlap rather than letting somebody add them up.
   */
  it('puts a multi-valued deal in every group it belongs to', () => {
    const rows = [deal({ deal_id: 'a', regions: ['Ontario', 'Quebec'] })]
    const groups = groupLedger(rows, 'regions')
    expect(groups.map((g) => g.label)).toEqual(['Ontario', 'Quebec'])
    expect(groups.every((g) => g.rows.length === 1)).toBe(true)
    expect(groupingOverlaps('regions')).toBe(true)
    expect(groupingOverlaps('owner_name')).toBe(false)
  })

  it('collects empty values under one heading, listed last', () => {
    const rows = [
      deal({ deal_id: 'a', regions: [] }),
      deal({ deal_id: 'b', regions: ['Ontario'] }),
    ]
    const groups = groupLedger(rows, 'regions')
    expect(groups.map((g) => g.label)).toEqual(['Ontario', 'Not set'])
    expect(groups[1].key).toBeNull()
  })

  it('reads an empty string as not set rather than as a group', () => {
    expect(groupValues(deal({ loss_reason: '' }), 'loss_reason')).toEqual([null])
    expect(groupValues(deal({ loss_reason: 'Price' }), 'loss_reason')).toEqual(['Price'])
  })
})

describe('totals', () => {
  it('keeps currencies apart', () => {
    const rows = [
      deal({ value: 100, currency: 'USD' }),
      deal({ value: 50, currency: 'CAD' }),
      deal({ value: 25, currency: 'USD' }),
    ]
    expect(summariseLedger(rows).totalValue).toEqual([
      { currency: 'CAD', value: 50 },
      { currency: 'USD', value: 125 },
    ])
  })

  it('counts each status and computes a win rate over closed deals only', () => {
    const rows = [
      deal({ status: 'won' }),
      deal({ status: 'won' }),
      deal({ status: 'lost' }),
      deal({ status: 'open' }),
    ]
    const summary = summariseLedger(rows)
    expect(summary).toMatchObject({ deals: 4, won: 2, lost: 1, open: 1 })
    // Two of three closed deals were won. The open deal is not a loss yet.
    expect(summary.winRate).toBeCloseTo(2 / 3)
  })

  it('reports no win rate at all when nothing has closed', () => {
    expect(summariseLedger([deal({ status: 'open' })]).winRate).toBeNull()
  })

  it('weights only the open pipeline', () => {
    const rows = [
      deal({ status: 'open', weighted_value: 500 }),
      deal({ status: 'won', weighted_value: 900 }),
    ]
    expect(summariseLedger(rows).openWeighted).toEqual([{ currency: 'USD', value: 500 }])
  })

  /*
   * The distinction the plan turned on: a hand-priced deal has no cost anywhere,
   * so its margin is unknown. Counting it as zero would report full margin on a
   * deal nobody has costed.
   */
  it('leaves a hand-priced deal out of the margin and says how many', () => {
    const rows = [
      deal({ margin: 400, revenue: 1000, cost: 600, line_count: 2, costed_lines: 2 }),
      deal({ margin: null, line_count: 0 }),
      deal({ margin: null, line_count: 0 }),
    ]
    const summary = summariseLedger(rows)
    expect(summary.margin).toEqual([{ currency: 'USD', value: 400 }])
    expect(summary.marginUnknown).toBe(2)
  })

  it('flags a margin computed from lines that have no cost', () => {
    const rows = [deal({ margin: 1000, revenue: 1000, cost: 0, line_count: 3, costed_lines: 1 })]
    expect(summariseLedger(rows).marginPartial).toBe(1)
  })

  it('takes the median cycle so one ancient deal does not define a team', () => {
    const rows = [
      deal({ status: 'won', cycle_days: 10 }),
      deal({ status: 'won', cycle_days: 20 }),
      deal({ status: 'lost', cycle_days: 400 }),
      deal({ status: 'open', cycle_days: null }),
    ]
    expect(summariseLedger(rows).medianCycle).toBe(20)
  })

  it('has no median to report before anything closes', () => {
    expect(median([])).toBeNull()
    expect(summariseLedger([deal()]).medianCycle).toBeNull()
  })

  it('averages the middle pair when the count is even', () => {
    expect(median([10, 20, 30, 40])).toBe(25)
  })
})

describe('export', () => {
  const cols = (...keys: LedgerColumnKey[]) => resolveColumns(keys, true)

  it('writes one line per deal, with lists joined', () => {
    const row = ledgerCsvRow(
      deal({ products: ['Speaker', 'Cable'], regions: ['Ontario', 'Quebec'] }),
      cols('products', 'regions', 'created_day'),
    )
    expect(row.Product).toBe('Speaker, Cable')
    expect(row.Region).toBe('Ontario, Quebec')
    expect(row.Initiated).toBe('2026-01-10')
  })

  it('leaves an unknown margin empty rather than writing a zero', () => {
    expect(ledgerCsvRow(deal({ margin: null }), cols('margin')).Margin).toBeNull()
  })

  /*
   * The file follows the screen. A column somebody hid to make the report
   * readable should not reappear in the download.
   */
  it('writes only the columns it was given, in that order', () => {
    const row = ledgerCsvRow(deal(), cols('status', 'name'))
    expect(Object.keys(row)).toEqual(['Status', 'Deal'])
  })

  it('writes money as a bare number a spreadsheet can total', () => {
    const row = ledgerCsvRow(deal({ value: 1000 }), cols('value'))
    expect(row.Value).toBe(1000)
  })

  /*
   * A column of amounts with no unit is the same wrong number this app refuses
   * to print anywhere else, so the currency follows the money out.
   */
  it('adds currency to an export carrying money without it', () => {
    const columns = exportColumns(cols('name', 'value'))
    expect(columns.map((column) => column.key)).toEqual(['name', 'value', 'currency'])
  })

  it('does not add currency twice', () => {
    const columns = exportColumns(cols('value', 'currency'))
    expect(columns.map((column) => column.key)).toEqual(['value', 'currency'])
  })

  it('leaves an export with no money alone', () => {
    const columns = exportColumns(cols('name', 'status'))
    expect(columns.map((column) => column.key)).toEqual(['name', 'status'])
  })

  it('reads every column without falling through', () => {
    const row = deal()
    for (const column of LEDGER_COLUMNS) {
      expect(ledgerCsvValue(row, column.key)).not.toBeUndefined()
    }
  })

  /*
   * The fraction as stored. A spreadsheet can format 0.35 as a percentage; it
   * cannot get back to a fraction from 35 without knowing the column was scaled
   * on the way out.
   */
  it('writes probability as the fraction, not the printed percentage', () => {
    expect(ledgerCsvValue(deal({ probability: 0.35 }), 'probability')).toBe(0.35)
  })

  it('writes a zero probability rather than reading it as missing', () => {
    expect(ledgerCsvValue(deal({ probability: 0 }), 'probability')).toBe(0)
    expect(ledgerCsvValue(deal({ line_count: 0 }), 'line_count')).toBe(0)
  })

  /*
   * Margin's rule, applied to the two numbers it is made of: a deal priced by
   * hand has no revenue or cost recorded anywhere, and a zero would read as a
   * fact rather than a gap.
   */
  it('leaves revenue and cost empty when there are no line items', () => {
    const row = deal({ revenue: null, cost: null })
    expect(ledgerCsvValue(row, 'revenue')).toBeNull()
    expect(ledgerCsvValue(row, 'cost')).toBeNull()
  })

  it('writes revenue and cost as bare numbers when there are', () => {
    const row = deal({ revenue: 900, cost: 400, line_count: 3 })
    expect(ledgerCsvValue(row, 'revenue')).toBe(900)
    expect(ledgerCsvValue(row, 'cost')).toBe(400)
    expect(ledgerCsvValue(row, 'line_count')).toBe(3)
  })

  it('writes the owner a deal counted for when it closed', () => {
    expect(ledgerCsvValue(deal({ closed_owner_name: 'Priya' }), 'closed_owner_name')).toBe('Priya')
    // Open deals have not counted for anybody yet.
    expect(ledgerCsvValue(deal(), 'closed_owner_name')).toBe('')
  })

  it('sends the currency along with revenue and cost too', () => {
    const columns = exportColumns(cols('revenue', 'cost'))
    expect(columns.map((column) => column.key)).toEqual(['revenue', 'cost', 'currency'])
  })
})

describe('finding the region field', () => {
  const field = (over: Partial<{ entity_type: string; key: string; label: string; field_type: string }>) => ({
    entity_type: 'company',
    key: 'regions',
    label: 'Regions',
    field_type: 'multiselect',
    ...over,
  })

  it('finds the company field an organization keeps regions in', () => {
    expect(regionFieldKey([field({})])).toBe('regions')
  })

  it('survives the field being renamed', () => {
    expect(regionFieldKey([field({ key: 'terr', label: 'Sales territory' })])).toBe('terr')
  })

  it('ignores a like-named field on another record', () => {
    expect(regionFieldKey([field({ entity_type: 'contact' })])).toBeNull()
  })

  it('returns nothing rather than guessing when there is no such field', () => {
    expect(regionFieldKey([field({ key: 'size', label: 'Size' })])).toBeNull()
    expect(regionFieldKey([])).toBeNull()
  })

  it('will not pick a free-text field it cannot offer as a filter', () => {
    expect(regionFieldKey([field({ field_type: 'text' })])).toBeNull()
  })
})

describe('choosing columns', () => {
  /*
   * Pinned as a list rather than derived from the definitions, so that adding a
   * column has to be a deliberate change to what everybody sees on Monday
   * morning instead of a side effect of defining one.
   */
  it('defaults to the reporting columns, in the order they were specified', () => {
    expect(DEFAULT_COLUMNS).toEqual([
      'name',
      'status',
      'owner_name',
      'pipeline_name',
      'stage_name',
      'value',
      'weighted_value',
      'margin',
      'company_name',
      'contact_name',
      'created_day',
      'expected_close_date',
      'actual_close_date',
      'cycle_days',
      'products',
      'regions',
      'loss_reason',
      'currency',
    ])
    expect(isDefaultColumns(DEFAULT_COLUMNS)).toBe(true)
  })

  /*
   * The workings behind the reporting columns: revenue and cost behind margin,
   * line items behind both, probability behind Weighted, and who the deal
   * counted for when it closed. Anybody checking a number wants them; anybody
   * reading the report does not, so they are on offer rather than on screen.
   */
  it('offers the detail columns without putting them on screen unasked', () => {
    const detail: LedgerColumnKey[] = [
      'closed_owner_name',
      'probability',
      'revenue',
      'cost',
      'line_count',
    ]
    const available = hiddenColumns(DEFAULT_COLUMNS).map((column) => column.key)

    for (const key of detail) {
      expect(columnFor(key)).toBeDefined()
      expect(DEFAULT_COLUMNS).not.toContain(key)
      expect(available).toContain(key)
    }
  })

  it('leaves nothing defined but unreachable', () => {
    const reachable = new Set([...DEFAULT_COLUMNS, ...hiddenColumns(DEFAULT_COLUMNS).map((c) => c.key)])
    expect(reachable.size).toBe(LEDGER_COLUMNS.length)
  })

  it('puts a detail column next to the one it explains', () => {
    const keys = LEDGER_COLUMNS.map((column) => column.key)
    expect(keys.indexOf('cost')).toBe(keys.indexOf('margin') - 1)
    expect(keys.indexOf('revenue')).toBe(keys.indexOf('cost') - 1)
    expect(keys.indexOf('closed_owner_name')).toBe(keys.indexOf('owner_name') + 1)
  })

  it('reads a layout from a comma separated list', () => {
    expect(parseColumns('name,value,status')).toEqual(['name', 'value', 'status'])
  })

  it('keeps the order asked for rather than the natural one', () => {
    expect(parseColumns('status,name')).toEqual(['status', 'name'])
  })

  it('tolerates spacing', () => {
    expect(parseColumns(' name , value ')).toEqual(['name', 'value'])
  })

  /*
   * The value comes from a URL or a cookie that an older version of the page
   * may have written. One column that no longer exists should cost the reader
   * that column, not the whole layout.
   */
  it('drops keys it does not recognise rather than rejecting the lot', () => {
    expect(parseColumns('name,invented,value')).toEqual(['name', 'value'])
  })

  it('drops duplicates, which would render the same column twice', () => {
    expect(parseColumns('name,name,value')).toEqual(['name', 'value'])
  })

  it('reports nothing usable rather than an empty table', () => {
    expect(parseColumns('')).toBeNull()
    expect(parseColumns(null)).toBeNull()
    expect(parseColumns('nonsense,rubbish')).toBeNull()
  })

  it('round-trips through the parameter', () => {
    const keys = parseColumns('status,name,margin')!
    expect(parseColumns(columnsParam(keys))).toEqual(keys)
  })

  it('resolves a layout to column definitions in the chosen order', () => {
    const resolved = resolveColumns(['value', 'name'], true)
    expect(resolved.map((column) => column.label)).toEqual(['Value', 'Deal'])
  })

  it('falls back to the default when nothing was chosen', () => {
    expect(resolveColumns(null, true).map((c) => c.key)).toEqual(DEFAULT_COLUMNS)
  })

  /*
   * A column that can only ever be empty is worse than one that is missing, so
   * region goes whatever the layout says.
   */
  it('drops the region column for an organization that keeps no region field', () => {
    expect(resolveColumns(['name', 'regions'], false).map((c) => c.key)).toEqual(['name'])
    expect(resolveColumns(['name', 'regions'], true).map((c) => c.key)).toEqual(['name', 'regions'])
  })

  it('lists what is hidden, in the natural order', () => {
    const hidden = hiddenColumns(['name', 'status'])
    expect(hidden.map((column) => column.key)).not.toContain('name')
    expect(hidden.map((column) => column.key)).toContain('value')
    expect(hidden).toHaveLength(LEDGER_COLUMNS.length - 2)
  })
})

describe('moving a column', () => {
  const keys = ['name', 'status', 'value'] as const

  it('swaps with the neighbour above', () => {
    expect(moveColumn([...keys], 'value', -1)).toEqual(['name', 'value', 'status'])
  })

  it('swaps with the neighbour below', () => {
    expect(moveColumn([...keys], 'name', 1)).toEqual(['status', 'name', 'value'])
  })

  // Wrapping around would send the first column to the bottom on a mis-click.
  it('stops at either end rather than wrapping', () => {
    expect(moveColumn([...keys], 'name', -1)).toEqual(['name', 'status', 'value'])
    expect(moveColumn([...keys], 'value', 1)).toEqual(['name', 'status', 'value'])
  })

  it('ignores a column that is not in the list', () => {
    expect(moveColumn([...keys], 'margin', -1)).toEqual(['name', 'status', 'value'])
  })

  it('does not modify the array it was given', () => {
    const original = [...keys]
    moveColumn(original, 'name', 1)
    expect(original).toEqual(['name', 'status', 'value'])
  })
})
