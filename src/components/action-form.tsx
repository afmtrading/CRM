'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

/**
 * A form whose action can say why it refused.
 *
 * A server action reached by a plain `<form action={fn}>` has no way to answer.
 * If it throws, Next.js redacts the message in production and renders
 *
 *     Application error: a server-side exception has occurred
 *     Digest: 1250239103
 *
 * which is what Settings → Pipelines → Delete did. The message the action
 * carefully wrote — "This pipeline still has 3 deals on the board" — went to the
 * server log, where the person pressing the button is not.
 *
 * So an action used here returns its message instead of throwing it, and this
 * renders it underneath. Throwing is still right for the things that are not
 * anybody's fault to fix — a broken connection, a bug — and those now reach the
 * error boundary in (app)/error.tsx rather than a blank page.
 */

export type ActionState = { error?: string; ok?: string }

export function ActionForm({
  action,
  className,
  children,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>
  className?: string
  children: React.ReactNode
}) {
  const [state, formAction] = useActionState(action, {})

  return (
    <div>
      <form action={formAction} className={className}>
        {children}
      </form>
      {(state.error ?? state.ok) && (
        <p
          role="status"
          className={`mt-1 text-xs ${state.error ? 'text-red-700' : 'text-emerald-700'}`}
        >
          {state.error ?? state.ok}
        </p>
      )}
    </div>
  )
}

/**
 * A submit button that knows its form is busy.
 *
 * Separate from ActionForm because useFormStatus reads the form it is rendered
 * inside, which means it has to be a component of its own — a hook in ActionForm
 * itself would be watching that component's parent instead.
 */
export function SubmitButton({
  className,
  pendingLabel,
  title,
  children,
}: {
  className?: string
  pendingLabel?: string
  title?: string
  children: React.ReactNode
}) {
  const { pending } = useFormStatus()

  return (
    <button type="submit" disabled={pending} className={className} title={title}>
      {pending ? (pendingLabel ?? children) : children}
    </button>
  )
}
