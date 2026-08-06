'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { createSupabaseBrowserClient } from '@/lib/supabase/client'

type Mode = 'password' | 'magic-link'

export function LoginForm({ next, initialError }: { next?: string; initialError?: string }) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [notice, setNotice] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    setNotice(null)

    const supabase = createSupabaseBrowserClient()

    if (mode === 'magic-link') {
      const { error: linkError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next ?? '/')}`,
        },
      })
      setPending(false)
      if (linkError) setError(linkError.message)
      else setNotice('Check your inbox for a sign-in link.')
      return
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    setPending(false)

    if (signInError) {
      setError(signInError.message)
      return
    }

    router.push(next ?? '/')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-5">
      <div>
        <label className="label" htmlFor="email">
          Work email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          className="input"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
        />
      </div>

      {mode === 'password' && (
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            className="input"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
      )}

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-700" role="status">
          {notice}
        </p>
      )}

      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? 'Signing in…' : mode === 'password' ? 'Sign in' : 'Email me a link'}
      </button>

      <button
        type="button"
        className="w-full text-center text-xs text-slate-500 hover:text-slate-700"
        onClick={() => {
          setMode(mode === 'password' ? 'magic-link' : 'password')
          setError(null)
          setNotice(null)
        }}
      >
        {mode === 'password' ? 'Sign in with an email link instead' : 'Use a password instead'}
      </button>
    </form>
  )
}
