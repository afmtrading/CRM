'use client'

import { useActionState, useEffect, useState } from 'react'

import type { ActionState } from '@/components/action-form'
import type { FieldOptionRow, OptionColor } from '@/lib/database.types'
import { OPTION_COLORS, OPTION_COLOR_CLASSES } from '@/lib/field-options'

import { deleteFieldOption, updateFieldOption } from '../actions'

/**
 * One option being edited.
 *
 * The colour was always changeable; the value never was. Correcting "Kenaya" to
 * "Kenya" meant deleting the option and adding the right one — and because a
 * record stores the value as text rather than as a link to this list, every
 * company already marked Kenaya stayed Kenaya, next to a list that no longer
 * offered it. The rename here goes to those records too, and says how many it
 * reached.
 */
function OptionEditRow({ option, close }: { option: FieldOptionRow; close: () => void }) {
  const [state, formAction, pending] = useActionState(updateFieldOption, {} as ActionState)

  useEffect(() => {
    if (state.ok) close()
  }, [state.ok, close])

  return (
    <li>
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={option.id} />

        <div className="min-w-40 flex-1">
          <label className="label" htmlFor={`option-value-${option.id}`}>
            Value
          </label>
          <input
            id={`option-value-${option.id}`}
            name="value"
            required
            autoFocus
            defaultValue={option.value}
            className="input py-1"
          />
        </div>

        <div>
          <label className="label" htmlFor={`option-color-${option.id}`}>
            Colour
          </label>
          <select
            id={`option-color-${option.id}`}
            name="color"
            defaultValue={option.color}
            className="input max-w-32 py-1 text-xs"
          >
            {OPTION_COLORS.map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" className="btn-primary px-3 py-1.5 text-xs" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={close}>
          Cancel
        </button>
      </form>

      {state.error && (
        <p role="status" className="mt-1 text-xs text-red-700">
          {state.error}
        </p>
      )}

      <p className="mt-1 text-xs text-slate-500">
        Renaming rewrites this value on every record carrying it, so the list and the records stay
        one vocabulary.
      </p>
    </li>
  )
}

export function FieldOptionRows({ options }: { options: FieldOptionRow[] }) {
  const [editing, setEditing] = useState<string | null>(null)

  if (options.length === 0) {
    return <p className="mb-4 text-sm text-slate-500">No values yet. Add the first one below.</p>
  }

  return (
    <ul className="mb-4 space-y-2">
      {options.map((option) =>
        editing === option.id ? (
          <OptionEditRow key={option.id} option={option} close={() => setEditing(null)} />
        ) : (
          <li key={option.id} className="flex flex-wrap items-center gap-2">
            <span className={`badge ${OPTION_COLOR_CLASSES[option.color as OptionColor]}`}>
              {option.value}
            </span>

            <span className="ml-auto flex items-center gap-3">
              <button
                type="button"
                onClick={() => setEditing(option.id)}
                className="text-xs text-slate-500 hover:text-brand-700"
              >
                Edit
              </button>
              <form action={deleteFieldOption}>
                <input type="hidden" name="id" value={option.id} />
                <button
                  type="submit"
                  className="px-1.5 text-sm text-slate-300 hover:text-red-600"
                  aria-label={`Delete ${option.value}`}
                >
                  ✕
                </button>
              </form>
            </span>
          </li>
        ),
      )}
    </ul>
  )
}
