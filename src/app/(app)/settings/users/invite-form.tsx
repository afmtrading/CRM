'use client'

import { useActionState } from 'react'

import { inviteUser, type InviteState } from '../actions'

/**
 * Four fields across, rather than four fields down.
 *
 * The form used to be the narrow column beside the user table and was built for
 * that shape. It sits above the table now, where a stack of full-width inputs
 * would be a column of very wide boxes for an email address and a name — so the
 * fields share the row and the button ends it.
 */
export function InviteUserForm() {
  const [state, formAction, pending] = useActionState(inviteUser, {} as InviteState)

  return (
    <form action={formAction} className="space-y-3">
      {state.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {state.ok}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_2fr_1fr_auto] lg:items-end">
        <div>
          <label className="label" htmlFor="invite-email">
            Email
          </label>
          <input id="invite-email" name="email" type="email" required className="input" />
        </div>

        <div>
          <label className="label" htmlFor="invite-name">
            Name
          </label>
          <input id="invite-name" name="name" className="input" />
        </div>

        <div>
          <label className="label" htmlFor="invite-role">
            Role
          </label>
          <select id="invite-role" name="role" className="input" defaultValue="regular">
            <option value="regular">Regular user</option>
            <option value="admin">Administrator</option>
          </select>
        </div>

        <button type="submit" className="btn-primary sm:col-span-2 lg:col-span-1" disabled={pending}>
          {pending ? 'Sending…' : 'Send invitation'}
        </button>
      </div>

      <p className="text-xs text-slate-400">
        They join this organization only. Their records stay walled off from every other company in
        the portfolio.
      </p>
    </form>
  )
}
