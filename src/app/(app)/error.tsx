'use client'

import Link from 'next/link'

/**
 * What the app shows when something throws.
 *
 * Without this file Next.js falls all the way back to its own blank page —
 *
 *     Application error: a server-side exception has occurred while loading
 *     crm.flo-ventures.com (see the server logs for more information).
 *     Digest: 1250239103
 *
 * — which is what Settings → Pipelines → Delete produced. No page furniture, no
 * way back except the browser's Back button, and a number.
 *
 * The digest is still the only identifier here: Next.js redacts the message of a
 * server-side error in production on purpose, so that a stack trace or a
 * connection string cannot be shown to whoever tripped it. That is the right
 * default and this page does not fight it. It shows the digest, because quoting
 * it is how anybody gets the real message out of the logs, and it offers a retry
 * — most of what reaches here is transient.
 *
 * Anything a person can actually fix should never arrive at this page. Those
 * belong in the form that caused them, through ActionForm, where the message
 * survives.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900">That didn’t work</h1>
      <p className="mt-2 text-sm text-slate-600">
        Something went wrong on our side. Nothing you were looking at has been changed.
      </p>

      <div className="mt-6 flex items-center justify-center gap-2">
        <button type="button" onClick={reset} className="btn-primary">
          Try again
        </button>
        <Link href="/" className="btn-secondary">
          Back to the dashboard
        </Link>
      </div>

      {error.digest && (
        <p className="mt-6 text-xs text-slate-400">
          Quote <code className="font-mono text-slate-500">{error.digest}</code> if you report this
          — it finds the details in the log.
        </p>
      )}
    </div>
  )
}
