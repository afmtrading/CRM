/**
 * The shapes behind the report charts.
 *
 * Pure: every function here turns ledger rows into buckets and every bucket
 * into geometry. Nothing draws — the page renders inline SVG from these — which
 * is what makes a chart testable rather than something you have to look at to
 * check.
 *
 * No charting library. These are bars and columns over a handful of buckets;
 * a dependency would not earn its place, and a server-rendered SVG ships no
 * JavaScript at all.
 *
 * ONE CURRENCY PER CHART
 *
 * A column chart adds its values up the axis, so a chart mixing USD and CAD
 * would draw a number that does not exist. Every series here is filtered to one
 * currency and the page draws one chart per currency it finds.
 */

import type { LedgerRow } from '@/lib/ledger'
import { closedInPeriod, creditedOwner, type Period } from '@/lib/performance'

// -----------------------------------------------------------------------------
// Months
// -----------------------------------------------------------------------------

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** 'YYYY-MM' for any date-ish string, read as written rather than localised. */
export function monthKeyOf(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})/.exec(value)
  return match ? `${match[1]}-${match[2]}` : null
}

export function monthLabel(key: string): string {
  const [year, month] = key.split('-')
  return `${MONTH_NAMES[Number(month) - 1]} ${year.slice(2)}`
}

/** Every month from first to last inclusive, so an empty month is a gap, not a skip. */
export function monthsBetween(first: string, last: string): string[] {
  if (first > last) return []

  const keys: string[] = []
  let [year, month] = first.split('-').map(Number)
  const [lastYear, lastMonth] = last.split('-').map(Number)

  // Bounded rather than while(true): a corrupt date should not hang a page.
  for (let guard = 0; guard < 600; guard += 1) {
    keys.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`)
    if (year === lastYear && month === lastMonth) break
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }

  return keys
}

/** Columns get unreadable long before this; the most recent months are the ones that matter. */
export const MAX_MONTHS = 24

// -----------------------------------------------------------------------------
// Won and lost over time
// -----------------------------------------------------------------------------

export interface MonthBucket {
  key: string
  label: string
  won: number
  lost: number
  wonCount: number
  lostCount: number
}

/**
 * Closed value per month, for one currency.
 *
 * Placed by close date, which is the date the money is attributed to — the same
 * rule the performance screen uses, so a column here and a tile there cannot
 * disagree.
 */
export function closedByMonth(
  rows: LedgerRow[],
  currency: string,
  period: Period,
): MonthBucket[] {
  const buckets = new Map<string, MonthBucket>()

  for (const row of rows) {
    if (row.status === 'open') continue
    if (row.currency.toUpperCase() !== currency.toUpperCase()) continue
    if (!closedInPeriod(row, period)) continue

    const key = monthKeyOf(row.actual_close_date ?? row.closed_day)
    if (!key) continue

    const bucket = buckets.get(key) ?? {
      key,
      label: monthLabel(key),
      won: 0,
      lost: 0,
      wonCount: 0,
      lostCount: 0,
    }

    if (row.status === 'won') {
      bucket.won += Number(row.value)
      bucket.wonCount += 1
    } else {
      bucket.lost += Number(row.value)
      bucket.lostCount += 1
    }

    buckets.set(key, bucket)
  }

  if (buckets.size === 0) return []

  const keys = [...buckets.keys()].sort()
  const filled = monthsBetween(keys[0], keys[keys.length - 1]).map(
    (key) =>
      buckets.get(key) ?? {
        key,
        label: monthLabel(key),
        won: 0,
        lost: 0,
        wonCount: 0,
        lostCount: 0,
      },
  )

  return filled.slice(-MAX_MONTHS)
}

/** The currencies actually present, so the page knows how many charts to draw. */
export function currenciesIn(rows: LedgerRow[]): string[] {
  return [...new Set(rows.map((row) => (row.currency || '').toUpperCase()).filter(Boolean))].sort()
}

// -----------------------------------------------------------------------------
// How long deals take
// -----------------------------------------------------------------------------

export interface CycleBucket {
  label: string
  /** Inclusive upper bound in days; Infinity for the tail. */
  max: number
  won: number
  lost: number
}

export const CYCLE_BOUNDS: { label: string; max: number }[] = [
  { label: '≤ 1 week', max: 7 },
  { label: '1–4 weeks', max: 30 },
  { label: '1–2 months', max: 60 },
  { label: '2–3 months', max: 90 },
  { label: '3–6 months', max: 180 },
  { label: '6 months +', max: Infinity },
]

/**
 * How long closed deals took, in buckets.
 *
 * Won and lost are counted separately on purpose: the useful reading is not
 * "deals take 40 days" but "the ones we lose take three times as long as the
 * ones we win", which a single distribution hides.
 */
export function cycleHistogram(rows: LedgerRow[], period: Period): CycleBucket[] {
  const buckets: CycleBucket[] = CYCLE_BOUNDS.map((bound) => ({ ...bound, won: 0, lost: 0 }))

  for (const row of rows) {
    if (row.status === 'open' || row.cycle_days === null) continue
    if (!closedInPeriod(row, period)) continue

    // A close date edited to before the deal was created gives a negative
    // cycle. It belongs in the first bucket rather than nowhere.
    const days = Math.max(0, row.cycle_days)
    const bucket = buckets.find((candidate) => days <= candidate.max)
    if (!bucket) continue

    if (row.status === 'won') bucket.won += 1
    else bucket.lost += 1
  }

  return buckets
}

// -----------------------------------------------------------------------------
// Where the open deals are
// -----------------------------------------------------------------------------

export interface StageBucket {
  stageId: string
  label: string
  pipeline: string
  order: number
  count: number
  value: number
  currency: string
}

/**
 * Open deals by stage, for one currency.
 *
 * NOT a conversion funnel, and labelled as such on the page. A funnel needs to
 * know which stages a deal *passed through*, and nothing records that: a deal
 * carries one stage_id, its current one. Showing this as a funnel would invite
 * "we lose 60% at Proposal" to be read off a chart that cannot support it.
 *
 * What it does answer is where the open pipeline is sitting right now, which is
 * a real question with a real answer.
 */
export function openByStage(rows: LedgerRow[], currency: string): StageBucket[] {
  const buckets = new Map<string, StageBucket>()

  for (const row of rows) {
    if (row.status !== 'open') continue
    if (row.currency.toUpperCase() !== currency.toUpperCase()) continue
    if (!row.stage_id) continue

    const bucket = buckets.get(row.stage_id) ?? {
      stageId: row.stage_id,
      label: row.stage_name ?? 'No stage',
      pipeline: row.pipeline_name ?? '',
      order: row.stage_order ?? 0,
      count: 0,
      value: 0,
      currency: currency.toUpperCase(),
    }

    bucket.count += 1
    bucket.value += Number(row.value)
    buckets.set(row.stage_id, bucket)
  }

  return [...buckets.values()].sort(
    (a, b) => a.pipeline.localeCompare(b.pipeline) || a.order - b.order,
  )
}

// -----------------------------------------------------------------------------
// The funnel
// -----------------------------------------------------------------------------

/** One row of stage_funnel(), which counts deals that ever arrived in a stage. */
export interface StageFunnelRow {
  stage_id: string
  stage_name: string
  stage_order: number
  pipeline_id: string
  reached: number
  still_there: number
  won_after: number
  lost_after: number
  median_days: number | null
}

export interface FunnelStep extends StageFunnelRow {
  /** Reached here as a share of the widest stage, for the bar. */
  share: number
  /** Reached here ÷ reached the stage before. Null at the top — nothing precedes it. */
  conversion: number | null
}

/**
 * Turns arrival counts into a funnel.
 *
 * Conversion is measured against the *previous* stage rather than the first,
 * because the question a funnel answers is "where do deals stop", and a rate
 * against the top of the funnel hides which step lost them.
 *
 * A stage nobody has reached gives no conversion rather than 0% — the same
 * refusal as a win rate over nothing.
 */
export function funnelSteps(rows: StageFunnelRow[]): FunnelStep[] {
  const ordered = [...rows].sort((a, b) => a.stage_order - b.stage_order)
  const widest = Math.max(1, ...ordered.map((row) => row.reached))

  return ordered.map((row, index) => {
    const previous = index === 0 ? null : ordered[index - 1]
    return {
      ...row,
      share: fraction(row.reached, widest),
      conversion: previous && previous.reached > 0 ? row.reached / previous.reached : null,
    }
  })
}

// -----------------------------------------------------------------------------
// Owners side by side
// -----------------------------------------------------------------------------

export interface OwnerBar {
  ownerId: string | null
  label: string
  won: number
  lost: number
  open: number
  wonCount: number
  winRate: number | null
}

/** Won, lost and open per owner in one currency, biggest winner first. */
export function ownerBars(rows: LedgerRow[], currency: string, period: Period): OwnerBar[] {
  const bars = new Map<string | null, OwnerBar>()

  for (const row of rows) {
    if (row.currency.toUpperCase() !== currency.toUpperCase()) continue
    if (row.status !== 'open' && !closedInPeriod(row, period)) continue

    const owner = creditedOwner(row)
    const bar = bars.get(owner.id) ?? {
      ownerId: owner.id,
      label: owner.name,
      won: 0,
      lost: 0,
      open: 0,
      wonCount: 0,
      winRate: null,
    }

    const value = Number(row.value)
    if (row.status === 'won') {
      bar.won += value
      bar.wonCount += 1
    } else if (row.status === 'lost') {
      bar.lost += value
    } else {
      bar.open += value
    }

    bars.set(owner.id, bar)
  }

  const counts = new Map<string | null, { won: number; lost: number }>()
  for (const row of rows) {
    if (row.status === 'open') continue
    if (row.currency.toUpperCase() !== currency.toUpperCase()) continue
    if (!closedInPeriod(row, period)) continue
    const owner = creditedOwner(row)
    const entry = counts.get(owner.id) ?? { won: 0, lost: 0 }
    if (row.status === 'won') entry.won += 1
    else entry.lost += 1
    counts.set(owner.id, entry)
  }

  return [...bars.values()]
    .map((bar) => {
      const closed = counts.get(bar.ownerId)
      const total = (closed?.won ?? 0) + (closed?.lost ?? 0)
      // No closed deals is no win rate, not nought per cent — the same rule the
      // performance table follows.
      return { ...bar, winRate: total === 0 ? null : (closed?.won ?? 0) / total }
    })
    .sort((a, b) => b.won - a.won || a.label.localeCompare(b.label))
}

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

/**
 * A round number at or above the largest value, for the top of an axis.
 *
 * An axis topped by the exact maximum makes the tallest column touch the ceiling
 * and gives the reader no sense of scale. 1, 2 or 5 times a power of ten is the
 * usual set of numbers people read without thinking.
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1

  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalised = value / magnitude

  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10
  return step * magnitude
}

/** A value as a share of the axis, clamped, safe when the axis is zero. */
export function fraction(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.max(0, Math.min(1, value / max))
}

/** Evenly spaced gridline values from zero to max, inclusive of both. */
export function ticks(max: number, count = 4): number[] {
  if (max <= 0 || count < 1) return [0]
  return Array.from({ length: count + 1 }, (_, index) => (max / count) * index)
}
