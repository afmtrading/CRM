import { describe, expect, it } from 'vitest'

import {
  AGE_BOUNDS,
  STALLED_AFTER_DAYS,
  ageingBuckets,
  daysBetween,
  lossCoverage,
  lossReasons,
  overdueDeals,
  stalledDeals,
  withoutCloseDate,
  type StageDurationRow,
} from '../src/lib/diagnostics'
import { periodRange } from '../src/lib/performance'
import type { LedgerRow } from '../src/lib/ledger'

const NOW = '2026-08-13'
const ALL = periodRange('all', NOW)

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
    company_id: null,
    company_name: null,
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
    created_at: '2026-08-01T00:00:00Z',
    created_day: '2026-08-01',
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

function lost(reason: string | null, overrides: Partial<LedgerRow> = {}): LedgerRow {
  return deal({
    status: 'lost',
    loss_reason: reason,
    actual_close_date: '2026-08-05',
    closed_at: '2026-08-05T00:00:00Z',
    cycle_days: 20,
    ...overrides,
  })
}

function span(overrides: Partial<StageDurationRow> = {}): StageDurationRow {
  return {
    deal_id: 'd1',
    stage_id: 's1',
    stage_name: 'Quote',
    entered_at: '2026-06-01T00:00:00Z',
    left_at: null,
    seconds_in: 60 * 86_400,
    is_current: true,
    source: 'move',
    ...overrides,
  }
}

describe('days between', () => {
  it('counts whole days in UTC', () => {
    expect(daysBetween('2026-08-01', '2026-08-13')).toBe(12)
    expect(daysBetween('2026-08-01T23:59:00Z', '2026-08-02T00:01:00Z')).toBe(1)
  })

  it('goes negative for a date in the future, and survives nonsense', () => {
    expect(daysBetween('2026-08-20', '2026-08-13')).toBe(-7)
    expect(daysBetween('not a date', '2026-08-13')).toBe(0)
  })

  /*
   * There is no today() any more. The organization's day is resolved once, in
   * lib/timezone, and passed in — so this module gives the same answer whatever
   * zone the server happens to be running in, which is the property that was
   * missing when it read the clock itself.
   */
  it('ages a deal against the day it is given, not the server clock', () => {
    const rows = [deal({ created_day: '2026-08-01' })]
    const near = ageingBuckets(rows, '2026-08-13').reduce((n, b) => n + b.deals, 0)
    const far = ageingBuckets(rows, '2027-08-13').reduce((n, b) => n + b.deals, 0)
    expect(near).toBe(1)
    expect(far).toBe(1)
    // Twelve months later the same deal is in an older bucket, which is only
    // true if the day passed in is what decides.
    expect(ageingBuckets(rows, '2026-08-13')).not.toEqual(ageingBuckets(rows, '2027-08-13'))
  })
})

describe('loss reasons', () => {
  it('groups lost deals by the reason given', () => {
    const reasons = lossReasons(
      [lost('Price', { deal_id: 'a' }), lost('Price', { deal_id: 'b' }), lost('Timing', { deal_id: 'c' })],
      ALL,
    )
    expect(reasons.map((reason) => reason.label)).toEqual(['Price', 'Timing'])
    expect(reasons[0]).toMatchObject({ deals: 2 })
    expect(reasons[0].share).toBeCloseTo(2 / 3)
  })

  it('ignores open and won deals', () => {
    expect(lossReasons([deal(), deal({ status: 'won' })], ALL)).toEqual([])
  })

  it('honours the period', () => {
    const rows = [lost('Price', { actual_close_date: '2026-01-05', closed_at: '2026-01-05T00:00:00Z' })]
    expect(lossReasons(rows, periodRange('this-quarter', NOW))).toEqual([])
    expect(lossReasons(rows, ALL)).toHaveLength(1)
  })

  /*
   * The row that decides whether the rest of the table means anything. Early on
   * it is usually the biggest, and hiding it would make a report built on a
   * third of the losses look like a picture of the business.
   */
  it('counts deals with no reason as their own row', () => {
    const reasons = lossReasons([lost('Price'), lost(null), lost(null)], ALL)
    const missing = reasons.find((reason) => reason.reason === null)
    expect(missing).toMatchObject({ label: 'No reason recorded', deals: 2 })
  })

  it('treats an empty or blank reason as no reason at all', () => {
    const reasons = lossReasons([lost(''), lost('   ')], ALL)
    expect(reasons).toHaveLength(1)
    expect(reasons[0].reason).toBeNull()
  })

  it('sorts unrecorded last however big it is', () => {
    const reasons = lossReasons([lost(null), lost(null), lost(null), lost('Price')], ALL)
    expect(reasons.map((reason) => reason.reason)).toEqual(['Price', null])
  })

  it('never adds two currencies together', () => {
    const reasons = lossReasons(
      [
        lost('Price', { value: 100, currency: 'USD' }),
        lost('Price', { value: 50, currency: 'CAD' }),
      ],
      ALL,
    )
    expect(reasons[0].value).toEqual([
      { currency: 'CAD', value: 50 },
      { currency: 'USD', value: 100 },
    ])
  })

  it('reports how much of the loss picture is known', () => {
    const reasons = lossReasons([lost('Price'), lost(null), lost(null), lost(null)], ALL)
    const coverage = lossCoverage(reasons)
    expect(coverage).toMatchObject({ recorded: 1, missing: 3 })
    expect(coverage.share).toBeCloseTo(0.25)
  })

  it('has no coverage figure when nothing was lost', () => {
    expect(lossCoverage([]).share).toBeNull()
  })
})

describe('ageing', () => {
  it('buckets open deals by age', () => {
    const buckets = ageingBuckets(
      [
        deal({ deal_id: 'a', created_at: '2026-08-10T00:00:00Z' }),
        deal({ deal_id: 'b', created_at: '2026-07-20T00:00:00Z' }),
        deal({ deal_id: 'c', created_at: '2025-01-01T00:00:00Z' }),
      ],
      NOW,
    )
    expect(buckets[0]).toMatchObject({ label: '≤ 1 week', deals: 1 })
    expect(buckets[1]).toMatchObject({ label: '1–4 weeks', deals: 1 })
    expect(buckets[4]).toMatchObject({ label: '6 months +', deals: 1 })
  })

  it('leaves closed deals out — a closed deal is not ageing', () => {
    const buckets = ageingBuckets([lost('Price'), deal({ status: 'won' })], NOW)
    expect(buckets.every((bucket) => bucket.deals === 0)).toBe(true)
  })

  it('always returns every bucket so the table keeps its shape', () => {
    expect(ageingBuckets([], NOW)).toHaveLength(AGE_BOUNDS.length)
  })

  it('totals value per currency inside a bucket', () => {
    const buckets = ageingBuckets(
      [
        deal({ deal_id: 'a', value: 100, currency: 'USD' }),
        deal({ deal_id: 'b', value: 40, currency: 'CAD' }),
      ],
      NOW,
    )
    expect(buckets[1].value).toEqual([
      { currency: 'CAD', value: 40 },
      { currency: 'USD', value: 100 },
    ])
  })
})

describe('overdue', () => {
  it('finds open deals past their expected close, latest first', () => {
    const rows = [
      deal({ deal_id: 'a', expected_close_date: '2026-08-01' }),
      deal({ deal_id: 'b', expected_close_date: '2026-07-01' }),
      deal({ deal_id: 'c', expected_close_date: '2026-09-01' }),
    ]
    const late = overdueDeals(rows, NOW)
    expect(late.map((entry) => entry.row.deal_id)).toEqual(['b', 'a'])
    expect(late[0].daysOverdue).toBe(43)
  })

  it('does not call a deal due today late', () => {
    expect(overdueDeals([deal({ expected_close_date: '2026-08-13' })], NOW)).toEqual([])
  })

  it('ignores closed deals however late they were', () => {
    expect(overdueDeals([lost('Price', { expected_close_date: '2020-01-01' })], NOW)).toEqual([])
  })

  /*
   * A deal with no expected close cannot be overdue, which is not the same as
   * being on track. It is counted separately so one problem cannot hide inside
   * the other.
   */
  it('counts open deals with no close date separately', () => {
    const rows = [deal({ deal_id: 'a' }), deal({ deal_id: 'b', expected_close_date: '2026-09-01' })]
    expect(overdueDeals(rows, NOW)).toEqual([])
    expect(withoutCloseDate(rows).map((row) => row.deal_id)).toEqual(['a'])
  })
})

describe('stalled', () => {
  it('finds open deals sitting in a stage past the threshold, longest first', () => {
    const rows = [deal({ deal_id: 'a' }), deal({ deal_id: 'b' })]
    const spans = [
      span({ deal_id: 'a', seconds_in: 40 * 86_400 }),
      span({ deal_id: 'b', seconds_in: 90 * 86_400 }),
    ]
    const stalled = stalledDeals(rows, spans)
    expect(stalled.map((entry) => entry.row.deal_id)).toEqual(['b', 'a'])
    expect(stalled[0].days).toBe(90)
  })

  it('leaves out anything below the threshold', () => {
    const spans = [span({ seconds_in: (STALLED_AFTER_DAYS - 1) * 86_400 })]
    expect(stalledDeals([deal()], spans)).toEqual([])
  })

  it('only reads the current span, not the ones the deal has left', () => {
    const spans = [
      span({ seconds_in: 400 * 86_400, is_current: false, stage_name: 'Old' }),
      span({ seconds_in: 2 * 86_400, is_current: true, stage_name: 'Quote' }),
    ]
    expect(stalledDeals([deal()], spans)).toEqual([])
  })

  it('ignores closed deals — they have stopped, not stalled', () => {
    expect(stalledDeals([lost('Price')], [span({ seconds_in: 400 * 86_400 })])).toEqual([])
  })

  it('says nothing about a deal it has no span for', () => {
    expect(stalledDeals([deal({ deal_id: 'unknown' })], [span({ deal_id: 'other' })])).toEqual([])
  })

  /*
   * A deal already sitting in its stage when recording began has been there at
   * least this long, not exactly this long. The screen marks it, so the number
   * is not read as more precise than it is.
   */
  it('flags a deal whose span only dates from when recording began', () => {
    const spans = [span({ seconds_in: 200 * 86_400, source: 'backfill' })]
    expect(stalledDeals([deal()], spans)[0].sinceRecordingBegan).toBe(true)
  })

  it('takes the threshold as an argument for a caller that wants a different one', () => {
    const spans = [span({ seconds_in: 10 * 86_400 })]
    expect(stalledDeals([deal()], spans, 7)).toHaveLength(1)
    expect(stalledDeals([deal()], spans, 14)).toHaveLength(0)
  })
})
