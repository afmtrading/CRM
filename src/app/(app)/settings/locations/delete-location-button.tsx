'use client'

import { useActionState } from 'react'

import type { ActionState } from '@/components/action-form'

import { deleteStockLocation } from '../actions'

/**
 * Deleting a location, as opposed to retiring it.
 *
 * Retire is still the first thing on the row and still the right answer for a
 * warehouse that ever held stock — it keeps the count of what was in it, which
 * is the whole reason `stock_levels` references the location `on delete
 * restrict`. This is for the other case: the location typed wrong, or opened
 * and never used, which had no way out of the list at all.
 *
 * It asks first because there is no bin for a location, and it shows the
 * server's refusal in place — "still holds a count for 4 products" is the
 * sentence that tells somebody to reach for Retire instead.
 */
export function DeleteLocationButton({
  id,
  name,
  bins,
}: {
  id: string
  name: string
  bins: number
}) {
  const [state, formAction] = useActionState(deleteStockLocation, {} as ActionState)

  return (
    <>
      <form
        action={formAction}
        onSubmit={(event) => {
          const confirmed = window.confirm(
            `Delete ${name}?\n\n` +
              (bins > 0
                ? `Its ${bins} bin${bins === 1 ? '' : 's'} go with it. `
                : '') +
              'Any stock movement recorded here keeps its history but stops naming a place.\n\n' +
              'This cannot be undone. To keep the history and only take the location out of the ' +
              'pickers, retire it instead.',
          )
          if (!confirmed) event.preventDefault()
        }}
      >
        <input type="hidden" name="id" value={id} />
        <button type="submit" className="text-xs text-slate-400 hover:text-red-600">
          Delete
        </button>
      </form>

      {state.error && (
        <p role="status" className="basis-full text-right text-xs text-red-700">
          {state.error}
        </p>
      )}
    </>
  )
}
