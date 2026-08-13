'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import {
  DEFAULT_COLUMNS,
  columnFor,
  columnsParam,
  hiddenColumns,
  isDefaultColumns,
  moveColumn,
  type LedgerColumnKey,
} from '@/lib/ledger'

import { rememberLedgerColumns } from './actions'

/**
 * Which columns the ledger shows, and in what order.
 *
 * Arrows rather than drag and drop. Dragging would need a library or a fair
 * amount of pointer handling, and it is the one interaction that cannot be
 * driven from a keyboard without building the keyboard version anyway — so the
 * keyboard version is the whole thing.
 *
 * The layout is applied by navigating, so it lands in the URL and a configured
 * ledger stays a link somebody can send. The cookie set alongside it is only so
 * the choice survives clicking Reports in the nav.
 */
export function ColumnPicker({
  chosen,
  /** Kept so the picker can rebuild the rest of the query when it navigates. */
  query,
  hasRegionField,
}: {
  chosen: LedgerColumnKey[]
  query: string
  hasRegionField: boolean
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [keys, setKeys] = useState<LedgerColumnKey[]>(chosen)

  // A region column is pointless without a region field, and the ledger drops
  // it anyway; leaving it out of the picker avoids offering a dead switch.
  const offered = (list: LedgerColumnKey[]) =>
    list.filter((key) => key !== 'regions' || hasRegionField)

  const shown = offered(keys)
  const available = hiddenColumns(keys).filter(
    (column) => column.key !== 'regions' || hasRegionField,
  )

  function apply(next: LedgerColumnKey[]) {
    const params = new URLSearchParams(query)
    const value = columnsParam(next)

    if (next.length === 0 || columnsParam(next) === columnsParam(DEFAULT_COLUMNS)) {
      params.delete('cols')
    } else {
      params.set('cols', value)
    }

    startTransition(async () => {
      // Remembered before navigating, so the render that follows already sees it.
      await rememberLedgerColumns(next.length === 0 ? null : value)
      const search = params.toString()
      router.push(search ? `/reports/deals?${search}` : '/reports/deals')
      router.refresh()
      setOpen(false)
    })
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="btn-secondary"
        aria-expanded={open}
      >
        Columns
        <span className="ml-1.5 text-xs text-slate-400">
          {/* Out of everything on offer here, not out of the default set —
              otherwise switching on an extra column reads as 19/18. */}
          {shown.length}/{shown.length + available.length}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Columns</h2>
            <span className="text-xs text-slate-400">
              {isDefaultColumns(keys) ? 'Default order' : 'Custom'}
            </span>
          </div>

          <ul className="max-h-72 space-y-0.5 overflow-y-auto">
            {shown.map((key, index) => {
              const column = columnFor(key)
              if (!column) return null

              return (
                <li key={key} className="flex items-center gap-1 rounded-md px-1 py-1 hover:bg-slate-50">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => setKeys(keys.filter((candidate) => candidate !== key))}
                      className="rounded border-slate-300"
                      // The table needs one column to be a table at all.
                      disabled={shown.length === 1}
                    />
                    <span className="truncate">{column.label}</span>
                  </label>

                  <button
                    type="button"
                    onClick={() => setKeys(moveColumn(keys, key, -1))}
                    disabled={index === 0}
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 disabled:hover:bg-transparent"
                    aria-label={`Move ${column.label} left`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => setKeys(moveColumn(keys, key, 1))}
                    disabled={index === shown.length - 1}
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 disabled:hover:bg-transparent"
                    aria-label={`Move ${column.label} right`}
                  >
                    ↓
                  </button>
                </li>
              )
            })}
          </ul>

          {available.length > 0 && (
            <>
              {/* "Available" rather than "Hidden": some of these have never
                  been on screen, so there is nothing to un-hide. */}
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs font-medium uppercase tracking-wide text-slate-400">
                Available
              </p>
              <ul className="mt-1 space-y-0.5">
                {available.map((column) => (
                  <li key={column.key}>
                    <label className="flex items-center gap-2 rounded-md px-1 py-1 text-sm text-slate-500 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={false}
                        // Added at the end, where somebody who just asked for it
                        // will look for it.
                        onChange={() => setKeys([...keys, column.key])}
                        className="rounded border-slate-300"
                      />
                      <span className="truncate">{column.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3">
            <button type="button" onClick={() => apply(keys)} className="btn-primary px-3 py-1.5 text-sm">
              Apply
            </button>
            <button
              type="button"
              onClick={() => {
                setKeys(DEFAULT_COLUMNS)
                apply(DEFAULT_COLUMNS)
              }}
              className="btn-secondary px-3 py-1.5 text-sm"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => {
                setKeys(chosen)
                setOpen(false)
              }}
              className="ml-auto text-sm text-slate-500 hover:text-slate-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
