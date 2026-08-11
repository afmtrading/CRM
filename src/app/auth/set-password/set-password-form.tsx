'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { createSupabaseBrowserClient } from '@/lib/supabase/client'

/** Short enough not to be theatre, long enough to be worth having. */
const MINIMUM = 8

/**
 * Where an invitation ends.
 *
 * An invited person arrives signed in but with no password, so the sign-in
 * page's password field is useless to them and the email-link option is not
 * obvious. Choosing one here means tomorrow's sign-in is ordinary. Skipping is
 * allowed — email links work perfectly well — but it is a decision rather than
 * something to discover later, locked out.
 */
export function SetPasswordForm({ next }: { next: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    if (password.length < MINIMUM) {
      return setError(`Use at least ${MINIMUM} characters.`)
    }
    if (password !== confirmation) {
      return setError('Those two do not match.')
    }

    setPending(true)
    const supabase = createSupabaseBrowserClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setPending(false)

    if (updateError) {
      // The likeliest cause is an expired link: the session never took, so
      // there is nobody to set a password for.
      return setError(updateError.message)
    }

    router.replace(next)
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-5">
      <p className="text-sm text-slate-600">
        You are signed in. Choose a password so you can sign in directly next time — or skip it and
        use an emailed link each time.
      </p>

      <div>
        <label className="label" htmlFor="password">
          New password
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="new-password"
          minLength={MINIMUM}
          className="input"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="confirmation">
          Repeat it
        </label>
        <input
          id="confirmation"
          type="password"
          required
          autoComplete="new-password"
          className="input"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? 'Saving…' : 'Save password and continue'}
      </button>

      <button
        type="button"
        className="w-full text-center text-xs text-slate-500 hover:text-slate-700"
        onClick={() => router.replace(next)}
      >
        Skip — I will use an email link each time
      </button>
    </form>
  )
}
