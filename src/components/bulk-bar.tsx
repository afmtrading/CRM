'use client'

import { useActionState, useEffect, useRef, useState } from 'react'

import { BULK_MODE_LABELS, type BulkField, type BulkMode } from '@/lib/bulk-edit'
import { bulkUpdate, type BulkState } from '@/app/(app)/bulk-actions'

/**
 * Select rows, change one field on all of them.
 *
 * The list it wraps stays a server component — it is passed in as children, so
 * nothing about the table has to move to the browser. The selection is plain
 * checkboxes named `ids` inside this form, which means the browser collects
 * them and no component holds a list of what is ticked. The only state here is
 * how many, which is the one thing markup cannot express.
 */

/** Ticks or clears every row in the form this sits in. */
export function SelectAll({ label }: { label: string }) {
  const ref = useRef<HTMLInputElement>(null)

  /*
   * Kept in step with the rows rather than left as a toggle somebody set once:
   * ticking every row by hand should fill this in, and unticking one should
   * turn it into the dash that means "some of them".
   */
  useEffect(() => {
    const box = ref.current
    const form = box?.form
    if (!box || !form) return

    const sync = () => {
      const rows = form.querySelectorAll<HTMLInputElement>('input[name="ids"]')
      const ticked = [...rows].filter((row) => row.checked).length
      box.checked = ticked > 0 && ticked === rows.length
      box.indeterminate = ticked > 0 && ticked < rows.length
    }

    sync()
    form.addEventListener('change', sync)
    return () => form.removeEventListener('change', sync)
  }, [])

  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      className="h-4 w-4 cursor-pointer rounded border-slate-300"
      onChange={(event) => {
        const form = event.currentTarget.form
        if (!form) return
        const checked = event.currentTarget.checked
        form.querySelectorAll<HTMLInputElement>('input[name="ids"]').forEach((row) => {
          row.checked = checked
        })
        // The rows changed programmatically, which fires no event of its own.
        form.dispatchEvent(new Event('change', { bubbles: true }))
      }}
    />
  )
}

/** One row's checkbox. Server-rendered inside the table. */
export function SelectRow({ id, label }: { id: string; label: string }) {
  return (
    <input
      type="checkbox"
      name="ids"
      value={id}
      aria-label={label}
      className="h-4 w-4 cursor-pointer rounded border-slate-300"
    />
  )
}

export function BulkEdit({
  entity,
  fields,
  children,
}: {
  entity: 'contact' | 'company'
  fields: BulkField[]
  children: React.ReactNode
}) {
  const [state, formAction, pending] = useActionState(bulkUpdate, {} as BulkState)
  const [selected, setSelected] = useState(0)
  const [fieldKey, setFieldKey] = useState(fields[0]?.key ?? '')
  const [mode, setMode] = useState<BulkMode>('set')
  const formRef = useRef<HTMLFormElement>(null)

  const field = fields.find((candidate) => candidate.key === fieldKey)

  // Counting the ticked rows is the one thing this cannot do without script.
  useEffect(() => {
    const form = formRef.current
    if (!form) return

    const count = () =>
      setSelected(form.querySelectorAll<HTMLInputElement>('input[name="ids"]:checked').length)

    count()
    form.addEventListener('change', count)
    return () => form.removeEventListener('change', count)
  }, [])

  // A change that made sense for the last field may not for this one.
  useEffect(() => {
    if (field && !field.modes.includes(mode)) setMode(field.modes[0])
  }, [field, mode])

  const noun = entity === 'contact' ? 'contact' : 'company'
  const plural = entity === 'contact' ? 'contacts' : 'companies'

  return (
    <form ref={formRef} action={formAction}>
      <input type="hidden" name="entity" value={entity} />

      {(state.ok || state.error) && (
        <p
          role="status"
          className={`mb-3 rounded-xl border px-3.5 py-2.5 text-sm ${
            state.error
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          {state.error ?? state.ok}
        </p>
      )}

      {/*
        Hidden until something is selected. A row of empty dropdowns above every
        list would be permanent furniture for an occasional job.
      */}
      {selected > 0 && (
        <div className="card mb-3 flex flex-wrap items-center gap-2 border-brand-200 bg-brand-50/60 p-3">
          <span className="text-sm font-medium text-slate-800">
            {selected} {selected === 1 ? noun : plural} selected
          </span>

          <span className="text-slate-300">·</span>

          <label className="sr-only" htmlFor="bulk-field">
            Field to change
          </label>
          <select
            id="bulk-field"
            name="field"
            className="input w-48 py-1.5 text-sm"
            value={fieldKey}
            onChange={(event) => setFieldKey(event.target.value)}
          >
            {fields.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.label}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="bulk-mode">
            What to do
          </label>
          <select
            id="bulk-mode"
            name="mode"
            className="input w-32 py-1.5 text-sm"
            value={mode}
            onChange={(event) => setMode(event.target.value as BulkMode)}
          >
            {(field?.modes ?? []).map((option) => (
              <option key={option} value={option}>
                {BULK_MODE_LABELS[option]}
              </option>
            ))}
          </select>

          {/* Clearing needs no value, and offering one would suggest otherwise. */}
          {mode !== 'clear' &&
            (field?.options ? (
              <>
                <label className="sr-only" htmlFor="bulk-values">
                  New value
                </label>
                <select
                  id="bulk-values"
                  name="values"
                  className="input w-52 py-1.5 text-sm"
                  // A list field takes several at once; a single-value one must
                  // not, or the database would keep whichever came first.
                  multiple={field.multiple}
                  size={field.multiple ? Math.min(4, Math.max(2, field.options.length)) : undefined}
                  defaultValue={field.multiple ? [] : ''}
                >
                  {!field.multiple && <option value="">Choose…</option>}
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {field.multiple && (
                  <span className="text-xs text-slate-500">Hold ⌘ or Ctrl to pick several</span>
                )}
              </>
            ) : (
              <input
                name="values"
                className="input w-52 py-1.5 text-sm"
                placeholder="New value"
                aria-label="New value"
              />
            ))}

          <button type="submit" className="btn-primary px-3 py-1.5 text-sm" disabled={pending}>
            {pending ? 'Applying…' : `Apply to ${selected}`}
          </button>

          {field?.options?.length === 0 && (
            <span className="text-xs text-amber-700">
              Nothing to choose from — add values for {field.label.toLowerCase()} in Settings →
              Fields.
            </span>
          )}
        </div>
      )}

      {children}
    </form>
  )
}
