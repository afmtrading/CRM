'use client'

import { useState } from 'react'
import Link from 'next/link'

import type { StockBinRow, StockLocationRow } from '@/lib/database.types'
import {
  type StockEntry,
  availableTone,
  formatQuantity,
  summariseEntries,
} from '@/lib/stock'
import { PlusIcon } from '@/components/icons'

/** One of the four headline numbers. */
function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-center">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${tone ?? 'text-slate-900'}`}>{value}</p>
    </div>
  )
}

/**
 * The stock card on the product form.
 *
 * Rows post as one JSON field rather than as indexed inputs, the same way the
 * links and addresses editors do — a repeater whose rows are added and removed
 * in the browser has no stable field names to give a server action.
 *
 * The tiles add up as you type. `committed` and `reserved` come from the server
 * because neither is a fact this form has: what open deals have promised is a
 * question about deals, and what is held back was set on the record rather than
 * here.
 */
export function StockEditor({
  locations,
  bins,
  defaultValue,
  committed = 0,
  reserved = 0,
}: {
  locations: StockLocationRow[]
  bins: StockBinRow[]
  defaultValue: StockEntry[]
  committed?: number
  reserved?: number
}) {
  const [rows, setRows] = useState<StockEntry[]>(
    defaultValue.length > 0 ? defaultValue : [{ location_id: '', bin_id: '', quantity: '' }],
  )

  const summary = summariseEntries(rows, committed, reserved)

  const update = (index: number, patch: Partial<StockEntry>) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  if (locations.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        There is nowhere to put stock yet.{' '}
        <Link href="/settings/locations" className="text-brand-700 hover:underline">
          Add a location
        </Link>{' '}
        first.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {/* Rows that name no location are dropped server-side, so a half-filled
          repeater never writes a phantom place. */}
      <input
        type="hidden"
        name="stock"
        value={JSON.stringify(rows.filter((row) => row.location_id))}
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <Tile label="On Hand" value={formatQuantity(summary.onHand)} />
        <Tile label="Committed" value={formatQuantity(summary.committed)} tone="text-amber-600" />
        <Tile label="Reserved" value={formatQuantity(summary.reserved)} tone="text-amber-600" />
        <Tile
          label="Available"
          value={formatQuantity(summary.available)}
          tone={availableTone(summary.available)}
        />
      </div>

      <div className="space-y-2">
        <div className="hidden gap-2 px-1 sm:grid sm:grid-cols-[1fr_1fr_8rem_2rem]">
          <span className="label mb-0">Location</span>
          <span className="label mb-0">Bin</span>
          <span className="label mb-0">Quantity</span>
          <span />
        </div>

        {rows.map((row, index) => {
          // A bin belongs to one location, so changing the location has to
          // clear the bin — otherwise the form would offer a shelf from a
          // different warehouse, and the database would refuse the save.
          const binsHere = bins.filter((bin) => bin.location_id === row.location_id)

          return (
            <div
              key={index}
              className="grid gap-2 sm:grid-cols-[1fr_1fr_8rem_2rem] sm:items-center"
            >
              <select
                className="input"
                value={row.location_id}
                onChange={(event) =>
                  update(index, { location_id: event.target.value, bin_id: '' })
                }
                aria-label={`Location for row ${index + 1}`}
              >
                <option value="">Location…</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                    {location.code ? ` (${location.code})` : ''}
                  </option>
                ))}
              </select>

              <select
                className="input"
                value={row.bin_id}
                disabled={binsHere.length === 0}
                onChange={(event) => update(index, { bin_id: event.target.value })}
                aria-label={`Bin for row ${index + 1}`}
              >
                <option value="">No bin</option>
                {binsHere.map((bin) => (
                  <option key={bin.id} value={bin.id}>
                    {bin.name}
                  </option>
                ))}
              </select>

              <input
                type="number"
                step="0.001"
                min="0"
                inputMode="decimal"
                className="input"
                placeholder="0"
                value={row.quantity}
                onChange={(event) => update(index, { quantity: event.target.value })}
                aria-label={`Quantity for row ${index + 1}`}
              />

              <button
                type="button"
                className="justify-self-start rounded-lg px-2 py-1 text-sm text-slate-400 hover:text-red-600 sm:justify-self-center"
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
                aria-label={`Remove row ${index + 1}`}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        className="btn-secondary"
        onClick={() => setRows([...rows, { location_id: '', bin_id: '', quantity: '' }])}
      >
        <PlusIcon className="h-4 w-4" />
        Add location
      </button>

      <p className="text-xs text-slate-400">
        Edits are recorded as stock adjustments — see the history on the product.
      </p>
    </div>
  )
}
