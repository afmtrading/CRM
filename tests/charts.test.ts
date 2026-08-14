import { describe, expect, it } from 'vitest'

import {
  CYCLE_BOUNDS,
  MAX_MONTHS,
  closedByMonth,
  currenciesIn,
  cycleHistogram,
  fraction,
  funnelSteps,
  monthKeyOf,
  monthLabel,
  monthsBetween,
  niceMax,
  openByStage,
  ownerBars,
  ticks,
  type StageFunnelRow,
} from '../src/lib/charts'
import { periodRange } from '../src/lib/performance'
import type { LedgerRow } from '../src/lib/ledger'
import { compactMoney } from '../src/components/charts'

const TODAY = '2026-08-13'
const ALL = periodRange('all', TODAY)

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

function closed(status: 'won' | 'lost', on: string, overrides: Partial<LedgerRow> = {}) {
  return deal({
    status,
    actual_close_date: on,
    closed_at: `${on}T00:00:00Z`,
    closed_owner_id: 'raj',
    closed_owner_name: 'Raj',
    cycle_days: 30,
    ...overrides,
  })
}

describe('months', () => {
  it('reads a month off any date-ish string', () => {
    expect(monthKeyOf('2026-08-13')).toBe('2026-08')
    expect(monthKeyOf('2026-08-13T23:30:00Z')).toBe('2026-08')
    expect(monthKeyOf(null)).toBeNull()
    expect(monthKeyOf('nonsense')).toBeNull()
  })

  it('labels a month for an axis', () => {
    expect(monthLabel('2026-08')).toBe('Aug 26')
    expect(monthLabel('2025-01')).toBe('Jan 25')
  })

  it('fills the gap between two months, inclusive of both', () => {
    expect(monthsBetween('2026-01', '2026-04')).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
  })

  it('crosses a year boundary', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('returns one month when both ends are the same, and none when reversed', () => {
    expect(monthsBetween('2026-03', '2026-03')).toEqual(['2026-03'])
    expect(monthsBetween('2026-05', '2026-01')).toEqual([])
  })
})

describe('closed value by month', () => {
  it('sums won and lost separately, per month', () => {
    const buckets = closedByMonth(
      [
        closed('won', '2026-07-05', { value: 1000 }),
        closed('won', '2026-07-20', { value: 500 }),
        closed('lost', '2026-07-25', { value: 300 }),
      ],
      'USD',
      ALL,
    )

    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ won: 1500, lost: 300, wonCount: 2, lostCount: 1 })
  })

  /*
   * An empty month has to be drawn as an empty column. Skipping it would put
   * March next to June and make a gap in trading look like continuity.
   */
  it('draws a month with nothing in it rather than skipping it', () => {
    const buckets = closedByMonth(
      [closed('won', '2026-01-10'), closed('won', '2026-04-10')],
      'USD',
      ALL,
    )
    expect(buckets.map((bucket) => bucket.key)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
    expect(buckets[1]).toMatchObject({ won: 0, lost: 0 })
  })

  it('keeps one currency out of another chart', () => {
    const rows = [
      closed('won', '2026-07-05', { value: 1000, currency: 'USD' }),
      closed('won', '2026-07-06', { value: 999, currency: 'CAD' }),
    ]
    expect(closedByMonth(rows, 'USD', ALL)[0].won).toBe(1000)
    expect(closedByMonth(rows, 'CAD', ALL)[0].won).toBe(999)
  })

  it('leaves open deals out — they have not closed', () => {
    expect(closedByMonth([deal()], 'USD', ALL)).toEqual([])
  })

  it('honours the period', () => {
    const rows = [closed('won', '2026-02-10'), closed('won', '2026-08-10')]
    const quarter = periodRange('this-quarter', TODAY)
    expect(closedByMonth(rows, 'USD', quarter).map((b) => b.key)).toEqual(['2026-08'])
  })

  it('shows only the most recent months when the history is long', () => {
    const rows = Array.from({ length: 40 }, (_, index) => {
      const year = 2023 + Math.floor(index / 12)
      const month = String((index % 12) + 1).padStart(2, '0')
      return closed('won', `${year}-${month}-05`, { deal_id: `d${index}` })
    })
    const buckets = closedByMonth(rows, 'USD', ALL)
    expect(buckets).toHaveLength(MAX_MONTHS)
  })

  it('lists the currencies present so the page knows how many charts to draw', () => {
    expect(currenciesIn([deal({ currency: 'USD' }), deal({ currency: 'cad' })])).toEqual([
      'CAD',
      'USD',
    ])
  })
})

describe('cycle histogram', () => {
  it('puts each closed deal in one bucket', () => {
    const buckets = cycleHistogram(
      [
        closed('won', '2026-08-01', { cycle_days: 3 }),
        closed('won', '2026-08-02', { cycle_days: 25 }),
        closed('lost', '2026-08-03', { cycle_days: 200 }),
      ],
      ALL,
    )

    expect(buckets[0]).toMatchObject({ label: '≤ 1 week', won: 1, lost: 0 })
    expect(buckets[1]).toMatchObject({ label: '1–4 weeks', won: 1, lost: 0 })
    expect(buckets[5]).toMatchObject({ label: '6 months +', won: 0, lost: 1 })
  })

  it('counts each bound as its own upper edge', () => {
    const buckets = cycleHistogram([closed('won', '2026-08-01', { cycle_days: 7 })], ALL)
    expect(buckets[0].won).toBe(1)
    expect(buckets[1].won).toBe(0)
  })

  /*
   * A close date edited to before the deal was created gives a negative cycle.
   * It is still a closed deal and belongs somewhere rather than vanishing.
   */
  it('keeps a deal with a negative cycle in the first bucket', () => {
    const buckets = cycleHistogram([closed('won', '2026-08-01', { cycle_days: -5 })], ALL)
    expect(buckets[0].won).toBe(1)
  })

  it('ignores open deals and deals with no length', () => {
    const buckets = cycleHistogram([deal(), closed('won', '2026-08-01', { cycle_days: null })], ALL)
    expect(buckets.every((bucket) => bucket.won === 0 && bucket.lost === 0)).toBe(true)
  })

  it('always returns every bucket, so the chart keeps its shape', () => {
    expect(cycleHistogram([], ALL)).toHaveLength(CYCLE_BOUNDS.length)
  })
})

describe('open deals by stage', () => {
  it('counts and sums open deals per stage, in stage order', () => {
    const rows = [
      deal({ deal_id: 'a', stage_id: 's2', stage_name: 'Proposal', stage_order: 1, value: 500 }),
      deal({ deal_id: 'b', stage_id: 's1', stage_name: 'Quote', stage_order: 0, value: 100 }),
      deal({ deal_id: 'c', stage_id: 's1', stage_name: 'Quote', stage_order: 0, value: 200 }),
    ]
    const stages = openByStage(rows, 'USD')
    expect(stages.map((stage) => stage.label)).toEqual(['Quote', 'Proposal'])
    expect(stages[0]).toMatchObject({ count: 2, value: 300 })
  })

  it('leaves closed deals out — they are not sitting anywhere', () => {
    expect(openByStage([closed('won', '2026-08-01')], 'USD')).toEqual([])
  })
})

describe('owner bars', () => {
  const rows = [
    closed('won', '2026-08-01', { deal_id: 'a', value: 1000 }),
    closed('lost', '2026-08-02', { deal_id: 'b', value: 400 }),
    deal({ deal_id: 'c', value: 2000 }),
    closed('won', '2026-08-03', {
      deal_id: 'd',
      value: 5000,
      closed_owner_id: 'rita',
      closed_owner_name: 'Rita',
    }),
  ]

  it('splits won, lost and open per owner', () => {
    const bars = ownerBars(rows, 'USD', ALL)
    const raj = bars.find((bar) => bar.ownerId === 'raj')
    expect(raj).toMatchObject({ won: 1000, lost: 400, open: 2000, wonCount: 1 })
  })

  it('ranks the biggest winner first', () => {
    expect(ownerBars(rows, 'USD', ALL).map((bar) => bar.ownerId)).toEqual(['rita', 'raj'])
  })

  it('gives an owner with nothing closed no win rate rather than zero', () => {
    const bars = ownerBars([deal({ owner_id: 'new', owner_name: 'New' })], 'USD', ALL)
    expect(bars[0].winRate).toBeNull()
  })

  it('computes a win rate from closed deals only', () => {
    const bars = ownerBars(rows, 'USD', ALL)
    expect(bars.find((bar) => bar.ownerId === 'raj')?.winRate).toBeCloseTo(0.5)
  })
})

describe('geometry', () => {
  it('rounds an axis up to a number people read without thinking', () => {
    expect(niceMax(9)).toBe(10)
    expect(niceMax(1200)).toBe(2000)
    expect(niceMax(4300)).toBe(5000)
    expect(niceMax(53000)).toBe(100000)
  })

  it('never returns a zero or negative axis', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(-5)).toBe(1)
    expect(niceMax(Number.NaN)).toBe(1)
  })

  it('clamps a fraction and survives an empty axis', () => {
    expect(fraction(50, 100)).toBe(0.5)
    expect(fraction(150, 100)).toBe(1)
    expect(fraction(-5, 100)).toBe(0)
    // The case that would otherwise render width: NaN% on an empty chart.
    expect(fraction(10, 0)).toBe(0)
  })

  it('spaces gridlines evenly from zero to the top', () => {
    expect(ticks(100, 4)).toEqual([0, 25, 50, 75, 100])
    expect(ticks(0)).toEqual([0])
  })
})

describe('compact money', () => {
  it('shortens amounts for an axis', () => {
    expect(compactMoney(950, 'USD')).toBe('$950')
    expect(compactMoney(1200, 'USD')).toBe('$1.2k')
    expect(compactMoney(12000, 'USD')).toBe('$12k')
    expect(compactMoney(1_500_000, 'USD')).toBe('$1.5M')
  })

  it('uses the currency’s own symbol', () => {
    expect(compactMoney(1200, 'GBP')).toBe('£1.2k')
  })
})

describe('the funnel', () => {
  const step = (over: Partial<StageFunnelRow>): StageFunnelRow => ({
    stage_id: 's1',
    stage_name: 'Quote',
    stage_order: 0,
    pipeline_id: 'p1',
    reached: 0,
    still_there: 0,
    won_after: 0,
    lost_after: 0,
    median_days: null,
    ...over,
  })

  it('orders by stage, whatever order the rows arrived in', () => {
    const steps = funnelSteps([
      step({ stage_id: 'c', stage_name: 'Won', stage_order: 2, reached: 3 }),
      step({ stage_id: 'a', stage_name: 'Quote', stage_order: 0, reached: 10 }),
      step({ stage_id: 'b', stage_name: 'Proposal', stage_order: 1, reached: 6 }),
    ])
    expect(steps.map((s) => s.stage_name)).toEqual(['Quote', 'Proposal', 'Won'])
  })

  /*
   * Against the previous stage, not the top of the funnel. "Where do deals
   * stop" is the question, and a rate against the first stage hides which
   * single step lost them.
   */
  it('measures conversion against the stage above', () => {
    const steps = funnelSteps([
      step({ stage_id: 'a', stage_order: 0, reached: 10 }),
      step({ stage_id: 'b', stage_order: 1, reached: 5 }),
      step({ stage_id: 'c', stage_order: 2, reached: 4 }),
    ])
    expect(steps[0].conversion).toBeNull()
    expect(steps[1].conversion).toBeCloseTo(0.5)
    expect(steps[2].conversion).toBeCloseTo(0.8)
  })

  it('gives no conversion rather than zero when nothing reached the stage above', () => {
    const steps = funnelSteps([
      step({ stage_id: 'a', stage_order: 0, reached: 0 }),
      step({ stage_id: 'b', stage_order: 1, reached: 0 }),
    ])
    expect(steps[1].conversion).toBeNull()
  })

  it('scales every bar against the widest stage', () => {
    const steps = funnelSteps([
      step({ stage_id: 'a', stage_order: 0, reached: 8 }),
      step({ stage_id: 'b', stage_order: 1, reached: 2 }),
    ])
    expect(steps[0].share).toBe(1)
    expect(steps[1].share).toBeCloseTo(0.25)
  })

  it('survives an empty funnel without dividing by zero', () => {
    expect(funnelSteps([])).toEqual([])
    expect(funnelSteps([step({})])[0].share).toBe(0)
  })
})
