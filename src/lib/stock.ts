/**
 * The four numbers, and the shape of a stock row on its way to the database.
 *
 * Pure — no server imports — so the arithmetic the form does while you type is
 * the same arithmetic the record does when it is read back.
 */

import type { StockLevelRow } from '@/lib/database.types'

/** A row of the stock editor: one product, in one place, in some quantity. */
export type StockEntry = {
  location_id: string
  /** Empty string rather than null: a `<select>` has no null. */
  bin_id: string
  quantity: string
}

export type StockSummary = {
  onHand: number
  committed: number
  reserved: number
  available: number
}

function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Adds the places up.
 *
 * `committed` is not derivable here — it comes off the open deals, which the
 * browser has no business querying — so it is passed in and defaults to none.
 * Everything else is the rows in front of you, which is what lets the tiles
 * move as somebody types into the editor.
 */
export function summarise(
  levels: Pick<StockLevelRow, 'quantity' | 'reserved'>[],
  committed = 0,
): StockSummary {
  const onHand = levels.reduce((total, level) => total + num(level.quantity), 0)
  const reserved = levels.reduce((total, level) => total + num(level.reserved), 0)

  return {
    onHand,
    committed,
    reserved,
    // Not clamped at zero. More promised than exists is the single most useful
    // thing this number can say, and hiding it behind a 0 is how a warehouse
    // finds out by disappointing somebody.
    available: onHand - committed - reserved,
  }
}

/** The same, for rows still being typed into the form. */
export function summariseEntries(entries: StockEntry[], committed = 0, reserved = 0): StockSummary {
  const onHand = entries.reduce((total, entry) => total + num(entry.quantity), 0)
  return { onHand, committed, reserved, available: onHand - committed - reserved }
}

/**
 * Two entries are the same place when they name the same location and bin.
 *
 * The key is what makes "no bin" one shelf rather than a new one on every save,
 * and it matches the `nulls not distinct` unique index the database holds.
 */
export function placeKey(locationId: string, binId: string | null | undefined): string {
  return `${locationId}:${binId || ''}`
}

/**
 * Drops the rows nobody filled in, and folds any duplicate places together.
 *
 * Somebody who adds the same warehouse twice means the total, not the last one
 * they typed — and letting both through would send two writes for one place and
 * leave the history claiming a movement that never happened.
 */
export function normaliseEntries(entries: StockEntry[]): StockEntry[] {
  const byPlace = new Map<string, StockEntry>()

  for (const entry of entries) {
    if (!entry.location_id) continue

    const key = placeKey(entry.location_id, entry.bin_id)
    const existing = byPlace.get(key)

    if (existing) {
      existing.quantity = String(num(existing.quantity) + num(entry.quantity))
    } else {
      byPlace.set(key, { ...entry, quantity: String(num(entry.quantity)) })
    }
  }

  return [...byPlace.values()]
}

/** How the Available tile reads: short when it is negative, plain when it is not. */
export function availableTone(available: number): string {
  if (available < 0) return 'text-red-600'
  if (available === 0) return 'text-slate-500'
  return 'text-emerald-600'
}

/** Quantities are numeric(14,3); trailing zeros in a count help nobody. */
export function formatQuantity(value: number | string | null | undefined): string {
  const parsed = num(value)
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(parsed)
}

/** A movement reads as a movement: +40, -12. */
export function formatDelta(value: number | string | null | undefined): string {
  const parsed = num(value)
  return `${parsed > 0 ? '+' : ''}${formatQuantity(parsed)}`
}
