/**
 * Diagnostics: why deals are lost, where they stop, and which ones have stalled.
 *
 * The other reports say what happened. These three say what to do about it, so
 * each one is built to point at a deal somebody can go and work — a number with
 * nothing behind it is not a diagnosis.
 *
 * Pure, like the rest of the reporting library.
 */

import type { LedgerRow } from '@/lib/ledger'
import { closedInPeriod, type Period } from '@/lib/performance'

export interface MoneyAmount {
  value: number
  currency: string
}

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

/** Whole days between two dates, read in UTC so a zone cannot shift the count. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`)
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.round((end - start) / 86_400_000)
}

export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

// -----------------------------------------------------------------------------
// Why deals are lost
// -----------------------------------------------------------------------------

export interface LossReason {
  /** Null is the deals nobody gave a reason for — the row that matters most early on. */
  reason: string | null
  label: string
  deals: number
  value: MoneyAmount[]
  /** Share of lost deals by count. */
  share: number
}

/**
 * Lost deals grouped by the reason given.
 *
 * Deals with no reason recorded are a row rather than an omission. Early on it
 * is usually the biggest row, and hiding it would make the rest of the table
 * look like a complete picture of why business is being lost when it is a
 * picture of the few times somebody filled the field in.
 */
export function lossReasons(rows: LedgerRow[], period: Period): LossReason[] {
  const lost = rows.filter((row) => row.status === 'lost' && closedInPeriod(row, period))
  if (lost.length === 0) return []

  const groups = new Map<string | null, LedgerRow[]>()
  for (const row of lost) {
    const key = row.loss_reason?.trim() || null
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  return [...groups.entries()]
    .map(([reason, group]) => ({
      reason,
      label: reason ?? 'No reason recorded',
      deals: group.length,
      value: byCurrency(group.map((row) => ({ value: Number(row.value), currency: row.currency }))),
      share: group.length / lost.length,
    }))
    .sort((a, b) => {
      // Unrecorded last however big it is: it is a gap in the data, not a
      // finding, and it should not head a list of reasons.
      if (a.reason === null) return 1
      if (b.reason === null) return -1
      return b.deals - a.deals || a.label.localeCompare(b.label)
    })
}

/** How much of the loss picture is actually known. */
export function lossCoverage(reasons: LossReason[]): {
  recorded: number
  missing: number
  share: number | null
} {
  const missing = reasons.find((reason) => reason.reason === null)?.deals ?? 0
  const total = reasons.reduce((sum, reason) => sum + reason.deals, 0)
  return {
    recorded: total - missing,
    missing,
    share: total === 0 ? null : (total - missing) / total,
  }
}

// -----------------------------------------------------------------------------
// Ageing
// -----------------------------------------------------------------------------

export const AGE_BOUNDS: { label: string; max: number }[] = [
  { label: '≤ 1 week', max: 7 },
  { label: '1–4 weeks', max: 30 },
  { label: '1–3 months', max: 90 },
  { label: '3–6 months', max: 180 },
  { label: '6 months +', max: Infinity },
]

export interface AgeBucket {
  label: string
  max: number
  deals: number
  value: MoneyAmount[]
}

/** Open deals by how long they have existed. */
export function ageingBuckets(rows: LedgerRow[], now: Date = new Date()): AgeBucket[] {
  const day = today(now)
  const buckets: AgeBucket[] = AGE_BOUNDS.map((bound) => ({ ...bound, deals: 0, value: [] }))
  const holding = new Map<string, { value: number; currency: string }[]>()

  for (const row of rows) {
    if (row.status !== 'open') continue

    const age = Math.max(0, daysBetween(row.created_at, day))
    const bucket = buckets.find((candidate) => age <= candidate.max)
    if (!bucket) continue

    bucket.deals += 1
    const list = holding.get(bucket.label) ?? []
    list.push({ value: Number(row.value), currency: row.currency })
    holding.set(bucket.label, list)
  }

  for (const bucket of buckets) {
    bucket.value = byCurrency(holding.get(bucket.label) ?? [])
  }

  return buckets
}

export interface OverdueDeal {
  row: LedgerRow
  daysOverdue: number
}

/**
 * Open deals whose expected close has already passed.
 *
 * Sorted by how late they are. A deal with no expected close date cannot be
 * late and is counted separately by `withoutCloseDate` — it is a different
 * problem with the same cause, and rolling the two together would let one hide
 * inside the other.
 */
export function overdueDeals(rows: LedgerRow[], now: Date = new Date()): OverdueDeal[] {
  const day = today(now)

  return rows
    .filter((row) => row.status === 'open' && row.expected_close_date)
    .map((row) => ({
      row,
      daysOverdue: daysBetween(row.expected_close_date as string, day),
    }))
    .filter((entry) => entry.daysOverdue > 0)
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
}

export function withoutCloseDate(rows: LedgerRow[]): LedgerRow[] {
  return rows.filter((row) => row.status === 'open' && !row.expected_close_date)
}

// -----------------------------------------------------------------------------
// Stalled in stage
// -----------------------------------------------------------------------------

/** One row of deal_stage_durations(). */
export interface StageDurationRow {
  deal_id: string
  stage_id: string | null
  stage_name: string | null
  entered_at: string
  left_at: string | null
  seconds_in: number
  is_current: boolean
  source: string
}

export interface StalledDeal {
  row: LedgerRow
  stageName: string
  days: number
  /**
   * True when the only thing known is that the deal was already in this stage
   * when recording began, so it has been there *at least* this long.
   */
  sinceRecordingBegan: boolean
}

/** Anything sitting this long without moving is worth a look. */
export const STALLED_AFTER_DAYS = 30

/**
 * Open deals that have not moved stage in a while, longest first.
 *
 * Reads the current span from deal_stage_durations rather than recomputing it:
 * one definition of "how long has this been here", in the database, where the
 * funnel's medians come from too.
 */
export function stalledDeals(
  rows: LedgerRow[],
  durations: StageDurationRow[],
  thresholdDays: number = STALLED_AFTER_DAYS,
): StalledDeal[] {
  const current = new Map<string, StageDurationRow>()
  for (const duration of durations) {
    if (duration.is_current) current.set(duration.deal_id, duration)
  }

  return rows
    .filter((row) => row.status === 'open')
    .map((row) => {
      const span = current.get(row.deal_id)
      if (!span) return null

      const days = Math.floor(Number(span.seconds_in) / 86_400)
      if (days < thresholdDays) return null

      return {
        row,
        stageName: span.stage_name ?? row.stage_name ?? 'No stage',
        days,
        sinceRecordingBegan: span.source === 'backfill',
      }
    })
    .filter((entry): entry is StalledDeal => entry !== null)
    .sort((a, b) => b.days - a.days)
}
