/**
 * Sales performance: overall, and per owner.
 *
 * Reads the same ledger rows the deal ledger screen does and turns them into
 * the handful of numbers that actually diagnose a sales team. Pure, so every
 * rule below is testable — and several of them are rules rather than sums.
 *
 * WHO A CLOSED DEAL COUNTS FOR
 *
 * A won deal counts for whoever owned it *when it closed*, not whoever owns it
 * now. That is the whole reason closed_owner_id was stamped in Phase 0: hand an
 * account to a colleague and the previous quarter's numbers must not move with
 * it. Open pipeline is the opposite — it counts for whoever owns it today,
 * because it is live work and the current owner is the one who has to close it.
 *
 * WHAT THE PERIOD APPLIES TO
 *
 * Closed deals, by close date. Open pipeline is always "as of now": a deal that
 * is still open was not open "in Q1 last year", it is open today, and filtering
 * it by a historical period would produce a number that means nothing.
 */

import { median, type LedgerRow } from '@/lib/ledger'

// The ledger already computes a median for its own cycle-time tile. One
// implementation, so the two screens can never quote different numbers.
export { median }

// -----------------------------------------------------------------------------
// Periods
// -----------------------------------------------------------------------------

export type PeriodKey =
  | 'all'
  | 'this-quarter'
  | 'last-quarter'
  | 'this-year'
  | 'last-year'
  | 'custom'

export interface Period {
  key: PeriodKey
  label: string
  /** Inclusive YYYY-MM-DD bounds. Null means unbounded on that side. */
  from: string | null
  to: string | null
}

export const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  // All time first, and the default: a young pipeline is the case where a
  // quarter-to-date screen is empty for reasons that have nothing to do with
  // performance, which reads as a broken report rather than a quiet quarter.
  { key: 'all', label: 'All time' },
  { key: 'this-quarter', label: 'This quarter' },
  { key: 'last-quarter', label: 'Last quarter' },
  { key: 'this-year', label: 'This year' },
  { key: 'last-year', label: 'Last year' },
  { key: 'custom', label: 'Custom range' },
]

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Last day of a month, without constructing a date in the caller's timezone. */
function lastDay(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month]
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function quarterRange(year: number, quarter: number): { from: string; to: string } {
  // A quarter that runs off either end of the year rolls into the next one.
  const rolledYear = year + Math.floor(quarter / 4)
  const rolled = ((quarter % 4) + 4) % 4
  const first = rolled * 3
  const last = first + 2
  return { from: iso(rolledYear, first, 1), to: iso(rolledYear, last, lastDay(rolledYear, last)) }
}

/**
 * Resolves a period to dates.
 *
 * `today` is a parameter rather than read from the clock so the result is the
 * same in a test as it is in December, and it is read in UTC to match the way
 * every date in this app is rendered.
 */
export function periodRange(
  key: PeriodKey,
  today: Date = new Date(),
  custom: { from?: string; to?: string } = {},
): Period {
  const year = today.getUTCFullYear()
  const quarter = Math.floor(today.getUTCMonth() / 3)

  switch (key) {
    case 'this-quarter': {
      const range = quarterRange(year, quarter)
      return { key, label: `Q${quarter + 1} ${year}`, ...range }
    }
    case 'last-quarter': {
      const range = quarterRange(year, quarter - 1)
      const shown = ((quarter - 1 + 4) % 4) + 1
      const shownYear = quarter === 0 ? year - 1 : year
      return { key, label: `Q${shown} ${shownYear}`, ...range }
    }
    case 'this-year':
      return { key, label: String(year), from: iso(year, 0, 1), to: iso(year, 11, 31) }
    case 'last-year':
      return {
        key,
        label: String(year - 1),
        from: iso(year - 1, 0, 1),
        to: iso(year - 1, 11, 31),
      }
    case 'custom': {
      const from = custom.from || null
      const to = custom.to || null
      if (!from && !to) return { key: 'all', label: 'All time', from: null, to: null }
      return {
        key,
        label: [from ?? 'the beginning', to ?? 'today'].join(' to '),
        from,
        to,
      }
    }
    default:
      return { key: 'all', label: 'All time', from: null, to: null }
  }
}

export function parsePeriodKey(raw: string | undefined): PeriodKey {
  return PERIOD_OPTIONS.some((option) => option.key === raw) ? (raw as PeriodKey) : 'all'
}

/**
 * Whether a closed deal falls in the period.
 *
 * A deal that closed without a close date recorded cannot be placed in time, so
 * it is excluded from a bounded period rather than silently counted in whatever
 * period happens to be on screen. It still appears under All time, where it is
 * visible rather than lost.
 */
export function closedInPeriod(row: LedgerRow, period: Period): boolean {
  if (!period.from && !period.to) return true

  const closed = row.actual_close_date ?? row.closed_at?.slice(0, 10) ?? null
  if (!closed) return false

  const day = closed.slice(0, 10)
  if (period.from && day < period.from) return false
  if (period.to && day > period.to) return false
  return true
}

// -----------------------------------------------------------------------------
// Attribution
// -----------------------------------------------------------------------------

export interface OwnerRef {
  id: string | null
  name: string
}

const UNASSIGNED: OwnerRef = { id: null, name: 'Unassigned' }

/**
 * Who a closed deal counts for: the owner it was closed by.
 *
 * Falls back to the current owner for deals that closed before the stamp
 * existed, which is what the Phase 0 backfill wrote and is the best answer
 * available for them.
 */
export function creditedOwner(row: LedgerRow): OwnerRef {
  if (row.status === 'open') {
    return row.owner_id ? { id: row.owner_id, name: row.owner_name ?? 'Unknown' } : UNASSIGNED
  }
  if (row.closed_owner_id) {
    return { id: row.closed_owner_id, name: row.closed_owner_name ?? 'Unknown' }
  }
  return row.owner_id ? { id: row.owner_id, name: row.owner_name ?? 'Unknown' } : UNASSIGNED
}

// -----------------------------------------------------------------------------
// Measures
// -----------------------------------------------------------------------------

export interface MoneyAmount {
  value: number
  currency: string
}

export interface Performance {
  owner: OwnerRef
  /** Closed within the period. */
  won: number
  lost: number
  /** Open right now, whatever the period. */
  open: number
  wonValue: MoneyAmount[]
  lostValue: MoneyAmount[]
  /** Won ÷ closed by count. Null when nothing closed in the period. */
  winRate: number | null
  /** Won value ÷ (won + lost) value, per currency. The number a big-deal seller looks different on. */
  winRateByValue: number | null
  /** Mean won deal, per currency — averaging across currencies would be meaningless. */
  averageDeal: MoneyAmount[]
  /** Median days from created to closed. Null when nothing closed. */
  medianCycle: number | null
  openPipeline: MoneyAmount[]
  openWeighted: MoneyAmount[]
  wonMargin: MoneyAmount[]
  /** Won deals with no line items, whose margin cannot be known. */
  marginUnknown: number
}

function sumByCurrency(rows: { value: number; currency: string }[]): MoneyAmount[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const currency = (row.currency || '').toUpperCase()
    totals.set(currency, (totals.get(currency) ?? 0) + row.value)
  }
  return [...totals.entries()]
    .map(([currency, value]) => ({ currency, value }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

function averageByCurrency(rows: { value: number; currency: string }[]): MoneyAmount[] {
  const totals = new Map<string, { total: number; count: number }>()
  for (const row of rows) {
    const currency = (row.currency || '').toUpperCase()
    const entry = totals.get(currency) ?? { total: 0, count: 0 }
    entry.total += row.value
    entry.count += 1
    totals.set(currency, entry)
  }
  return [...totals.entries()]
    .map(([currency, entry]) => ({ currency, value: Math.round(entry.total / entry.count) }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

/**
 * The measures for one set of deals.
 *
 * `closed` and `open` are passed separately because they are selected by
 * different rules — the period applies to one and not the other — and folding
 * that decision in here would hide it.
 */
export function measure(owner: OwnerRef, closed: LedgerRow[], open: LedgerRow[]): Performance {
  const won = closed.filter((row) => row.status === 'won')
  const lost = closed.filter((row) => row.status === 'lost')

  const wonAmounts = won.map((row) => ({ value: Number(row.value), currency: row.currency }))
  const lostAmounts = lost.map((row) => ({ value: Number(row.value), currency: row.currency }))

  const wonTotal = wonAmounts.reduce((sum, row) => sum + row.value, 0)
  const lostTotal = lostAmounts.reduce((sum, row) => sum + row.value, 0)

  const costed = won.filter((row) => row.margin !== null)

  return {
    owner,
    won: won.length,
    lost: lost.length,
    open: open.length,
    wonValue: sumByCurrency(wonAmounts),
    lostValue: sumByCurrency(lostAmounts),
    // Nothing closed is not a 0% win rate. It is no answer at all, and showing
    // zero would rank an owner who has closed nothing below one who lost.
    winRate: won.length + lost.length === 0 ? null : won.length / (won.length + lost.length),
    winRateByValue: wonTotal + lostTotal === 0 ? null : wonTotal / (wonTotal + lostTotal),
    averageDeal: averageByCurrency(wonAmounts),
    medianCycle: median(
      closed.filter((row) => row.cycle_days !== null).map((row) => row.cycle_days as number),
    ),
    openPipeline: sumByCurrency(
      open.map((row) => ({ value: Number(row.value), currency: row.currency })),
    ),
    openWeighted: sumByCurrency(
      open.map((row) => ({ value: Number(row.weighted_value), currency: row.currency })),
    ),
    wonMargin: sumByCurrency(
      costed.map((row) => ({ value: Number(row.margin), currency: row.currency })),
    ),
    marginUnknown: won.length - costed.length,
  }
}

/** Everything the viewer can see, as one set of numbers. */
export function overallPerformance(rows: LedgerRow[], period: Period): Performance {
  const closed = rows.filter((row) => row.status !== 'open' && closedInPeriod(row, period))
  const open = rows.filter((row) => row.status === 'open')
  return measure({ id: null, name: 'Everyone' }, closed, open)
}

/**
 * The same numbers per owner.
 *
 * Sorted by won value descending, which is the order a sales director reads a
 * table like this in. Owners with nothing at all are left out rather than
 * padding the table with zeroes.
 */
export function performanceByOwner(rows: LedgerRow[], period: Period): Performance[] {
  const closedByOwner = new Map<string | null, { owner: OwnerRef; rows: LedgerRow[] }>()
  const openByOwner = new Map<string | null, { owner: OwnerRef; rows: LedgerRow[] }>()

  for (const row of rows) {
    const owner = creditedOwner(row)
    const target = row.status === 'open' ? openByOwner : closedByOwner

    if (row.status !== 'open' && !closedInPeriod(row, period)) continue

    const entry = target.get(owner.id) ?? { owner, rows: [] }
    entry.rows.push(row)
    target.set(owner.id, entry)
  }

  const ids = new Set([...closedByOwner.keys(), ...openByOwner.keys()])

  return [...ids]
    .map((id) => {
      const owner = (closedByOwner.get(id) ?? openByOwner.get(id))?.owner ?? UNASSIGNED
      return measure(owner, closedByOwner.get(id)?.rows ?? [], openByOwner.get(id)?.rows ?? [])
    })
    .sort((a, b) => {
      const left = a.wonValue.reduce((sum, row) => sum + row.value, 0)
      const right = b.wonValue.reduce((sum, row) => sum + row.value, 0)
      if (left !== right) return right - left
      return a.owner.name.localeCompare(b.owner.name)
    })
}

// -----------------------------------------------------------------------------
// What the screen is allowed to say
// -----------------------------------------------------------------------------

/**
 * Whether the owner table is a comparison or a single person's own numbers.
 *
 * Not a permission check — the ledger function is invoker, so the database has
 * already decided which deals arrived. This only decides the wording, so that a
 * rep reading "Everyone" is not misled into thinking it means the company.
 */
export function performanceScope(canManage: boolean, ownerCount: number): 'organization' | 'own' {
  return canManage || ownerCount > 1 ? 'organization' : 'own'
}
