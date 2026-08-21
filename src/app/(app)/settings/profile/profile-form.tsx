'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import type { UserRow } from '@/lib/database.types'

import { updateProfile } from '../actions'

/**
 * Two fields, and a deliberate absence.
 *
 * Role, status and permission set are not here, and not because the form is
 * unfinished: a page that lets somebody edit their own row is exactly where a
 * privilege would be handed out by accident. The database refuses those
 * columns from a non-administrator whatever this form posts — see the trigger
 * in 20260266000000 — and this simply agrees with it.
 */
export function ProfileForm({ user }: { user: UserRow }) {
  return (
    <ActionForm action={updateProfile} className="grid gap-4 sm:grid-cols-2">
      <div>
        <label className="label" htmlFor="profile-name">
          Full name
        </label>
        <input
          id="profile-name"
          name="name"
          className="input"
          defaultValue={user.name ?? ''}
          placeholder="Ruben Ortiz"
        />
        <p className="mt-1 text-xs text-slate-400">
          As it should read on a document — the representative line under the letterhead.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="profile-phone">
          Phone
        </label>
        <input
          id="profile-phone"
          name="phone"
          className="input"
          defaultValue={user.phone ?? ''}
          placeholder="615-335-5582"
        />
        <p className="mt-1 text-xs text-slate-400">
          Printed beside your name, so a customer holding the order can reach you.
        </p>
      </div>

      <div className="sm:col-span-2">
        <SubmitButton className="btn-primary" pendingLabel="Saving…">
          Save profile
        </SubmitButton>
      </div>
    </ActionForm>
  )
}
