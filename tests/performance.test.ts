import { describe, expect, it } from 'vitest'

import {
  PERIOD_OPTIONS,
  closedInPeriod,
  creditedOwner,
  measure,
  overallPerformance,
  parsePeriodKey,
  performanceByOwner,
  performanceScope,
  periodRange,
} from '../src/lib/performance'
import type { LedgerRow } from '../src/lib/ledger'

const TODAY = '2026-08-13'

function deal(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    deal_id: 'd1',
    name: 'Deal',
    status: 'open',
    pipeline_id: 'p1',
    pipeline_name: 'Quotes',
    stage_id: 's1',
    stage_name: 'Quote',
    stage_order: 0,
    owner_id: 'raj',
    owner_name: 'Raj',
    closed_owner_id: null,
    closed_owner_name: null,
    company_id: 'c1',
    company_name: 'ACME',
    contact_id: null,
    contact_name: null,
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
    expected_close_date: null,
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

/** A deal closed on a date, credited to an owner at close. */
function closed(
  status: 'won' | 'lost',
  on: string,
  overrides: Partial<LedgerRow> = {},
): LedgerRow {
  return deal({
    status,
    actual_close_date: on,
    closed_at: `${on}T00:00:00Z`,
    closed_owner_id: overrides.closed_owner_id ?? 'raj',
    closed_owner_name: overrides.closed_owner_name ?? 'Raj',
    cycle_days: 30,
    ...overrides,
  })
}

describe('periods', () => {
  it('resolves this quarter from the date, not the clock', () => {
    const period = periodRange('this-quarter', TODAY)
    expect(period).toMatchObject({ label: 'Q3 2026', from: '2026-07-01', to: '2026-09-30' })
  })

  it('resolves last quarter', () => {
    expect(periodRange('last-quarter', TODAY)).toMatchObject({
      label: 'Q2 2026',
      from: '2026-04-01',
      to: '2026-06-30',
    })
  })

  it('rolls last quarter back into the previous year in January', () => {
    expect(periodRange('last-quarter', '2026-01-15')).toMatchObject({
      label: 'Q4 2025',
      from: '2025-10-01',
      to: '2025-12-31',
    })
  })

  it('handles a leap year in the first quarter', () => {
    expect(periodRange('this-quarter', '2028-02-10').to).toBe('2028-03-31')
    expect(periodRange('this-year', '2028-02-10')).toMatchObject({
      from: '2028-01-01',
      to: '2028-12-31',
    })
  })

  it('covers whole years', () => {
    expect(periodRange('this-year', TODAY)).toMatchObject({ from: '2026-01-01', to: '2026-12-31' })
    expect(periodRange('last-year', TODAY)).toMatchObject({ from: '2025-01-01', to: '2025-12-31' })
  })

  it('leaves all time unbounded', () => {
    expect(periodRange('all', TODAY)).toMatchObject({ from: null, to: null })
  })

  it('falls back to all time for an empty custom range', () => {
    expect(periodRange('custom', TODAY, {})).toMatchObject({ key: 'all', from: null, to: null })
  })

  it('accepts a one-sided custom range', () => {
    expect(periodRange('custom', TODAY, { from: '2026-05-01' })).toMatchObject({
      from: '2026-05-01',
      to: null,
    })
  })

  it('ignores a period it does not know', () => {
    expect(parsePeriodKey('last-decade')).toBe('all')
    expect(parsePeriodKey(undefined)).toBe('all')
    for (const option of PERIOD_OPTIONS) expect(parsePeriodKey(option.key)).toBe(option.key)
  })
})

describe('what falls inside a period', () => {
  const period = periodRange('this-quarter', TODAY)

  it('includes a deal closed inside it, at either edge', () => {
    expect(closedInPeriod(closed('won', '2026-07-01'), period)).toBe(true)
    expect(closedInPeriod(closed('won', '2026-09-30'), period)).toBe(true)
  })

  it('excludes one closed outside it', () => {
    expect(closedInPeriod(closed('won', '2026-06-30'), period)).toBe(false)
  })

  /*
   * A closed deal with no close date cannot be placed in time. Counting it in
   * whatever period happens to be on screen would move a number the moment
   * somebody changed the period, which is the opposite of what a period means.
   */
  it('excludes a closed deal with no date from a bounded period, but not from all time', () => {
    const undated = deal({ status: 'won', actual_close_date: null, closed_at: null })
    expect(closedInPeriod(undated, period)).toBe(false)
    expect(closedInPeriod(undated, periodRange('all', TODAY))).toBe(true)
  })

  it('falls back to the system close stamp when the date was cleared', () => {
    // closed_day, not a slice of closed_at: the stamp is an instant, and the
    // day it fell on is the organization's to decide.
    const row = deal({
      status: 'won',
      actual_close_date: null,
      closed_at: '2026-08-01T09:00:00Z',
      closed_day: '2026-08-01',
    })
    expect(closedInPeriod(row, period)).toBe(true)
  })
})

describe('who a deal counts for', () => {
  /*
   * The reason closed_owner_id was stamped in Phase 0. Reassigning an account
   * must not move a closed quarter's numbers to its new owner.
   */
  it('credits a closed deal to the owner it was closed by', () => {
    const row = closed('won', '2026-08-01', {
      owner_id: 'rita',
      owner_name: 'Rita',
      closed_owner_id: 'raj',
      closed_owner_name: 'Raj',
    })
    expect(creditedOwner(row)).toEqual({ id: 'raj', name: 'Raj' })
  })

  it('credits an open deal to whoever owns it now', () => {
    const row = deal({ owner_id: 'rita', owner_name: 'Rita', closed_owner_id: 'raj' })
    expect(creditedOwner(row)).toEqual({ id: 'rita', name: 'Rita' })
  })

  it('falls back to the current owner for a deal closed before the stamp existed', () => {
    const row = deal({ status: 'won', closed_owner_id: null, owner_id: 'raj', owner_name: 'Raj' })
    expect(creditedOwner(row)).toEqual({ id: 'raj', name: 'Raj' })
  })

  it('calls an unowned deal unassigned rather than dropping it', () => {
    const row = deal({ owner_id: null, owner_name: null, closed_owner_id: null })
    expect(creditedOwner(row)).toEqual({ id: null, name: 'Unassigned' })
  })
})

describe('measures', () => {
  const owner = { id: 'raj', name: 'Raj' }

  it('computes a win rate by count and by value', () => {
    const result = measure(
      owner,
      [
        closed('won', '2026-08-01', { value: 1000 }),
        closed('lost', '2026-08-02', { value: 3000 }),
      ],
      [],
    )
    expect(result.winRate).toBeCloseTo(0.5)
    // By value the picture is different, which is the point of showing both.
    expect(result.winRateByValue).toBeCloseTo(0.25)
  })

  it('reports no win rate when nothing closed, rather than zero', () => {
    const result = measure(owner, [], [deal()])
    expect(result.winRate).toBeNull()
    expect(result.winRateByValue).toBeNull()
  })

  it('averages the won deals per currency', () => {
    const result = measure(
      owner,
      [
        closed('won', '2026-08-01', { value: 1000, currency: 'USD' }),
        closed('won', '2026-08-02', { value: 3000, currency: 'USD' }),
        closed('won', '2026-08-03', { value: 500, currency: 'CAD' }),
      ],
      [],
    )
    expect(result.averageDeal).toEqual([
      { currency: 'CAD', value: 500 },
      { currency: 'USD', value: 2000 },
    ])
  })

  it('never adds two currencies together', () => {
    const result = measure(
      owner,
      [
        closed('won', '2026-08-01', { value: 100, currency: 'USD' }),
        closed('won', '2026-08-02', { value: 100, currency: 'CAD' }),
      ],
      [],
    )
    expect(result.wonValue).toEqual([
      { currency: 'CAD', value: 100 },
      { currency: 'USD', value: 100 },
    ])
  })

  it('takes a median cycle over closed deals', () => {
    const result = measure(
      owner,
      [
        closed('won', '2026-08-01', { cycle_days: 5 }),
        closed('won', '2026-08-02', { cycle_days: 15 }),
        closed('lost', '2026-08-03', { cycle_days: 400 }),
      ],
      [],
    )
    expect(result.medianCycle).toBe(15)
  })

  it('leaves an uncosted won deal out of margin and counts it', () => {
    const result = measure(
      owner,
      [
        closed('won', '2026-08-01', { margin: 300, line_count: 1, costed_lines: 1 }),
        closed('won', '2026-08-02', { margin: null, line_count: 0 }),
      ],
      [],
    )
    expect(result.wonMargin).toEqual([{ currency: 'USD', value: 300 }])
    expect(result.marginUnknown).toBe(1)
  })

  it('sums open pipeline and its weighted value separately', () => {
    const result = measure(owner, [], [deal({ value: 1000, weighted_value: 250 })])
    expect(result.openPipeline).toEqual([{ currency: 'USD', value: 1000 }])
    expect(result.openWeighted).toEqual([{ currency: 'USD', value: 250 }])
  })
})

describe('overall and per owner', () => {
  const quarter = periodRange('this-quarter', TODAY)

  const rows: LedgerRow[] = [
    // Raj won one this quarter and lost one.
    closed('won', '2026-08-01', { deal_id: 'a', value: 1000 }),
    closed('lost', '2026-08-05', { deal_id: 'b', value: 400 }),
    // Rita won one last quarter — outside this period.
    closed('won', '2026-05-01', {
      deal_id: 'c',
      value: 9000,
      closed_owner_id: 'rita',
      closed_owner_name: 'Rita',
    }),
    // Rita has something open right now.
    deal({ deal_id: 'd', owner_id: 'rita', owner_name: 'Rita', value: 2000, weighted_value: 600 }),
  ]

  it('counts only deals closed inside the period', () => {
    const overall = overallPerformance(rows, quarter)
    expect(overall.won).toBe(1)
    expect(overall.lost).toBe(1)
    expect(overall.wonValue).toEqual([{ currency: 'USD', value: 1000 }])
  })

  /*
   * Open pipeline is deliberately not filtered by the period: a deal that is
   * still open is open *today*, not "open in Q2", and filtering it by a
   * historical range would report a number that describes nothing.
   */
  it('counts open pipeline as of today whatever the period', () => {
    expect(overallPerformance(rows, quarter).openPipeline).toEqual([
      { currency: 'USD', value: 2000 },
    ])
    expect(overallPerformance(rows, periodRange('last-year', TODAY)).openPipeline).toEqual([
      { currency: 'USD', value: 2000 },
    ])
  })

  it('splits the same rules per owner', () => {
    const owners = performanceByOwner(rows, quarter)
    const raj = owners.find((row) => row.owner.id === 'raj')
    const rita = owners.find((row) => row.owner.id === 'rita')

    expect(raj).toMatchObject({ won: 1, lost: 1 })
    // Rita's win was last quarter, so it is not in this period — but her open
    // deal still is, because open is always now.
    expect(rita).toMatchObject({ won: 0, lost: 0, open: 1 })
    expect(rita?.openPipeline).toEqual([{ currency: 'USD', value: 2000 }])
  })

  it('ranks owners by won value', () => {
    const owners = performanceByOwner(rows, periodRange('all', TODAY))
    expect(owners.map((row) => row.owner.id)).toEqual(['rita', 'raj'])
  })

  it('leaves out owners with nothing in the period at all', () => {
    const owners = performanceByOwner(
      [closed('won', '2026-08-01', { deal_id: 'a' })],
      quarter,
    )
    expect(owners).toHaveLength(1)
  })

  it('reports nothing rather than zeroes for an empty period', () => {
    const overall = overallPerformance(rows, periodRange('last-year', TODAY))
    expect(overall.won).toBe(0)
    expect(overall.winRate).toBeNull()
    expect(overall.medianCycle).toBeNull()
  })
})

describe('what the screen may claim', () => {
  /*
   * Not a permission check — the ledger function is invoker, so the database
   * already decided which rows arrived. This only decides the wording, so a rep
   * is never shown "Everyone" over a table holding one person.
   */
  it('calls a single rep’s view their own', () => {
    expect(performanceScope(false, 1)).toBe('own')
  })

  it('calls a manager’s view the organization even with one owner', () => {
    expect(performanceScope(true, 1)).toBe('organization')
  })

  it('treats several owners as an organization view', () => {
    expect(performanceScope(false, 3)).toBe('organization')
  })
})
