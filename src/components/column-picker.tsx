'use client'

import { useEffect, useRef, useState } from 'react'

import {
  moveColumn,
  type TableColumn,
  type TableEntity,
} from '@/lib/table-columns'
import { resetColumns, saveColumns } from '@/app/(app)/column-actions'

/**
 * Choosing which columns a list shows, and in what order.
 *
 * The list in the dialog is the table's column order, top to bottom — ticked
 * rows are the columns, unticked ones are what could be added. Reordering is
 * dragging, with the same move available from the keyboard, because a dialog
 * whose only interaction is a drag is a dialog some people cannot use.
 *
 * Nothing is saved until Save. Cancel restores what was there on open rather
 * than what the server holds, so a change made and thought better of does not
 * survive by having been typed.
 */
export function ColumnPicker({
  entity,
  catalogue,
  selected,
}: {
  entity: TableEntity
  catalogue: TableColumn[]
  /** Keys in display order, as the table is rendering them now. */
  selected: string[]
}) {
  const [open, setOpen] = useState(false)
  const [order, setOrder] = useState<string[]>(() => layout(catalogue, selected))
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(selected))
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const byKey = new Map(catalogue.map((column) => [column.key, column]))

  /*
   * Reopening starts from what the table is actually showing. Without this, a
   * cancelled edit would still be sitting there the next time the dialog
   * opened, which reads as the change having been saved.
   */
  useEffect(() => {
    if (!open) return
    setOrder(layout(catalogue, selected))
    setChosen(new Set(selected))
  }, [open, catalogue, selected])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const toggle = (key: string, locked?: boolean) => {
    if (locked) return
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const move = (from: number, to: number) => setOrder((current) => moveColumn(current, from, to))

  const save = async () => {
    setSaving(true)
    try {
      // Order first, then filtered: the stored list has to be in the order the
      // dialog shows, not in catalogue order.
      await saveColumns(entity, order.filter((key) => chosen.has(key)))
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        <ColumnsIcon />
        Columns
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          // Only a click that starts and ends on the backdrop closes it, so a
          // drag that finishes outside the dialog does not dismiss the work.
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Customize columns"
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">Customize columns</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
              {order.map((key, index) => {
                const column = byKey.get(key)
                if (!column) return null

                const ticked = chosen.has(key)
                const isDragging = dragging === index

                return (
                  <li
                    key={key}
                    draggable
                    onDragStart={() => setDragging(index)}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(event) => {
                      event.preventDefault()
                      if (dragging === null || dragging === index) return
                      move(dragging, index)
                      setDragging(index)
                    }}
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${
                      isDragging
                        ? 'border-brand-300 bg-brand-50 opacity-70'
                        : 'border-slate-200 bg-white'
                    }`}
                  >
                    <input
                      type="checkbox"
                      id={`column-${key}`}
                      checked={ticked}
                      disabled={column.locked}
                      onChange={() => toggle(key, column.locked)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    <label
                      htmlFor={`column-${key}`}
                      className={`flex-1 truncate text-sm ${
                        column.locked
                          ? 'text-slate-400'
                          : ticked
                            ? 'font-medium text-slate-800'
                            : 'text-slate-500'
                      }`}
                      title={column.locked ? 'Always shown' : undefined}
                    >
                      {column.label}
                    </label>

                    {/*
                      The same move as the drag, reachable from a keyboard. The
                      handle is the drag affordance; these are what make it
                      usable without a mouse.
                    */}
                    <span className="flex items-center gap-0.5">
                      <button
                        type="button"
                        className="rounded px-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                        onClick={() => move(index, index - 1)}
                        disabled={index === 0}
                        aria-label={`Move ${column.label} up`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="rounded px-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                        onClick={() => move(index, index + 1)}
                        disabled={index === order.length - 1}
                        aria-label={`Move ${column.label} down`}
                      >
                        ↓
                      </button>
                      <span className="cursor-grab px-1 text-slate-300" aria-hidden="true">
                        ⠿
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>

            <div className="mt-5 flex items-center justify-between gap-2">
              {/*
                Forgets the preference rather than writing the defaults into
                it. Stored defaults would freeze this list at today's catalogue
                — a column added next year would never appear for anybody who
                had ever pressed this.
              */}
              <button
                type="button"
                className="text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50"
                disabled={saving}
                onClick={async () => {
                  setSaving(true)
                  try {
                    await resetColumns(entity)
                    setOpen(false)
                  } finally {
                    setSaving(false)
                  }
                }}
              >
                Reset to default
              </button>

              <div className="flex gap-2">
                <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={save}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * The dialog's row order: what is shown, in its order, then everything else.
 *
 * Unticking a column leaves it where it is rather than dropping it to the
 * bottom — it is a mistake somebody may be about to undo, and a row that jumps
 * away the moment it is unticked is one they then have to hunt for.
 */
function layout(catalogue: TableColumn[], selected: string[]): string[] {
  const known = new Set(catalogue.map((column) => column.key))
  const shown = selected.filter((key) => known.has(key))
  const rest = catalogue.filter((column) => !shown.includes(column.key)).map((c) => c.key)
  return [...shown, ...rest]
}

function ColumnsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </svg>
  )
}
