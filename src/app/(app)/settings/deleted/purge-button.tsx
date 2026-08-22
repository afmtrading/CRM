'use client'

import { useActionState } from 'react'

import type { ActionState } from '@/components/action-form'

/**
 * The other way out of the bin.
 *
 * Restoring was the only thing this page could do, so "delete" really meant
 * "hide from everybody except the administrators" and a thousand rows imported
 * by mistake stayed a thousand rows forever. This is the second of two steps on
 * purpose: the first one — the delete button on the record's own page — is
 * undoable and says so, and this one is reached only by somebody standing in
 * the bin looking at what they deleted.
 *
 * It asks, naming the record, and it shows a refusal where it happened: a
 * company a sales order still refers to cannot go, because the document that
 * names it has to keep working.
 */
export function PurgeButton({
  action,
  id,
  label,
  what,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>
  id: string
  label: string
  /** "contact", "company" — what the confirmation calls the thing. */
  what: string
}) {
  const [state, formAction] = useActionState(action, {} as ActionState)

  return (
    <>
      <form
        action={formAction}
        onSubmit={(event) => {
          const confirmed = window.confirm(
            `Delete ${label} for good?\n\n` +
              `This ${what} and everything stored on it — its history, its notes, its ` +
              'activity — are removed from the database.\n\n' +
              'This cannot be undone. Leaving it in the bin costs nothing: it is already out of ' +
              "everyone else's way.",
          )
          if (!confirmed) event.preventDefault()
        }}
      >
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="label" value={label} />
        <button type="submit" className="text-xs text-slate-400 hover:text-red-600">
          Delete
        </button>
      </form>

      {state.error && (
        <p role="status" className="mt-1 max-w-xs text-left text-xs text-red-700">
          {state.error}
        </p>
      )}
    </>
  )
}
