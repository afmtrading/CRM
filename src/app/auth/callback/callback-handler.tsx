'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import type { EmailOtpType } from '@supabase/supabase-js'

/**
 * Where every sign-in link lands, whatever shape Supabase sends it in.
 *
 * There are three, and the CRM needs all of them:
 *
 *   1. `#access_token=…&refresh_token=…` in the URL *fragment*. This is what an
 *      invitation sent by `inviteUserByEmail` produces. A fragment is never
 *      transmitted to a server, so the old route handler — which only looked
 *      for `?code=` — saw an empty query and said "missing-code" every single
 *      time. Every invitation was dead on arrival.
 *   2. `?code=` from PKCE. That works only in the browser that *started* the
 *      flow, because the verifier is held there — true for a magic link the
 *      person requested, never true for an invitation an administrator sent.
 *      Exchanging it here rather than on the server is what makes that
 *      distinction stop mattering.
 *   3. `?token_hash=&type=` from the newer email templates.
 *
 * Handling this in the browser is not a stylistic choice: a fragment is only
 * readable here, and the browser client writes the session to the same cookies
 * the server reads, so the app is properly signed in either way.
 */
export function CallbackHandler({ next }: { next: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    const url = new URL(window.location.href)
    const query = url.searchParams
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''))

    /**
     * An invited person has no password yet, and a password reset is the same
     * shape, so both go to set one rather than to a CRM they cannot sign back
     * into tomorrow.
     */
    const destination = (type: string | null) =>
      type === 'invite' || type === 'recovery' || type === 'signup'
        ? `/auth/set-password?next=${encodeURIComponent(next)}`
        : next

    async function run() {
      // Google and Supabase both report failures this way, and the message is
      // more use than anything this page could invent.
      const described = hash.get('error_description') ?? query.get('error_description')
      if (described) return setError(described)

      const accessToken = hash.get('access_token')
      const refreshToken = hash.get('refresh_token')
      const code = query.get('code')
      const tokenHash = query.get('token_hash')
      const type = query.get('type') ?? hash.get('type')

      let failed: string | null = null

      if (accessToken && refreshToken) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
        failed = sessionError?.message ?? null
      } else if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
        failed = exchangeError?.message ?? null
      } else if (tokenHash && type) {
        const { error: otpError } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: type as EmailOtpType,
        })
        failed = otpError?.message ?? null
      } else {
        failed = 'That sign-in link is missing its credentials. It may have already been used.'
      }

      if (failed) return setError(failed)

      // Best effort: a failed stamp is not worth blocking a sign-in over.
      await fetch('/api/auth/touch', { method: 'POST' }).catch(() => {})

      router.replace(destination(type))
      router.refresh()
    }

    void run()
  }, [next, router])

  if (error) {
    return (
      <div className="card space-y-3 p-5 text-sm">
        <p className="rounded-md bg-red-50 px-3 py-2 text-red-700" role="alert">
          {error}
        </p>
        <p className="text-slate-600">
          Sign-in links can only be used once and expire after a while. Ask for a fresh one from the
          sign-in page.
        </p>
        <a href="/login" className="btn-primary w-full text-center">
          Back to sign in
        </a>
      </div>
    )
  }

  return <p className="text-center text-sm text-slate-500">Signing you in…</p>
}
