'use client'

import { useActionState } from 'react'

import { inviteUser, type InviteState } from '../actions'

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

      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? 'Sending…' : 'Send invitation'}
      </button>

      <p className="text-xs text-slate-400">
        They join this organization only. Their records stay walled off from every other company in
        the portfolio.
      </p>
    </form>
  )
}
