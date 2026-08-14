'use client'

import { useState } from 'react'

/**
 * The button that actually unsubscribes.
 *
 * Posts to /api/unsubscribe, which is the same route the one-click header in
 * every campaign email already points at. That route calls
 * `unsubscribe_by_token` — one of exactly two functions anon may execute — as a
 * server client, so the token never needs a Supabase client in the browser.
 *
 * It used to build one here, which pulled the whole of @supabase/ssr into this
 * page: 69 kB gzipped, on a page opened by somebody who has just been sent an
 * email they did not want, usually on a phone, to press one button. The route
 * it duplicated was already sitting there.
 *
 * One difference worth naming: the route answers 200 for a token it does not
 * recognise, deliberately, so that a reply cannot be used to work out which
 * tokens are real. So this reports success where the old code reported an
 * error. That costs nothing here — the page only renders this button for a
 * token it has already checked and found unused — and it turns a double click
 * from a false alarm into what the person meant.
 */
export function UnsubscribeForm({ token }: { token: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function unsubscribe() {
    setPending(true)
    setError(null)

    try {
      const response = await fetch(`/api/unsubscribe?t=${encodeURIComponent(token)}`, {
        method: 'POST',
      })
      const body = (await response.json()) as { ok?: boolean }

      if (!response.ok || body.ok !== true) throw new Error('refused')
    } catch {
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
