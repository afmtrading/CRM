'use client'

import { useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'

import { supabaseAnonKey, supabaseUrl } from '@/lib/env'

/**
 * The button that actually unsubscribes.
 *
 * Calls the database directly as anon rather than going through a server
 * action, because a server action would be a POST into an app whose every
 * other route assumes a session. `unsubscribe_by_token` is one of exactly two
 * functions anon may execute, and it takes nothing but the token.
 */
export function UnsubscribeForm({ token }: { token: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function unsubscribe() {
    setPending(true)
    setError(null)

    const supabase = createBrowserClient(supabaseUrl(), supabaseAnonKey())
    const { data, error: rpcError } = await supabase.rpc('unsubscribe_by_token', {
      p_token: token,
    })

    if (rpcError || data !== true) {
      setPending(false)
      setError('That didn’t go through. Try again, or reply to the email and we’ll do it for you.')
      return
    }

    // Reloaded rather than swapped in place, so a refresh shows the finished
    // state instead of offering the button again.
    window.location.replace(`/unsubscribe?t=${encodeURIComponent(token)}&done=1`)
  }

  return (
    <div className="space-y-2">
      <button type="button" className="btn-primary" onClick={unsubscribe} disabled={pending}>
        {pending ? 'Unsubscribing…' : 'Unsubscribe'}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  )
}
