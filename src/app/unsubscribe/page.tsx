import { createServerClient } from '@supabase/ssr'

import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from '@/lib/env'

import { UnsubscribeForm } from './unsubscribe-form'

export const metadata = { title: 'Unsubscribe · FLO CRM' }

/**
 * The page at the end of an unsubscribe link.
 *
 * Nobody here is signed in, and nobody should have to be. The token in the URL
 * is the whole authorisation: it names exactly one contact, it is random rather
 * than derived from anything guessable, and possessing it is the proof. So this
 * page builds its own anonymous Supabase client rather than going through the
 * tenancy helper, which exists to answer questions about a logged-in user.
 *
 * It does not unsubscribe on load. A GET that changes something is a link a
 * mail client's link-scanner can trip by looking at it — which would silently
 * unsubscribe people who never clicked. So this shows a button, and the change
 * happens on POST.
 */

/** Anonymous, sessionless — the two functions it calls are the only ones anon may run. */
function anonClient() {
  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: { getAll: () => [], setAll: () => {} },
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; done?: string }>
}) {
  const { t, done } = await searchParams
  const token = typeof t === 'string' && UUID.test(t) ? t : null

  if (!isSupabaseConfigured() || !token) {
    return (
      <Shell title="This link doesn’t look right">
        <p>
          Check that you copied the whole address from the email. If it still fails, reply to the
          message and we’ll take you off the list by hand.
        </p>
      </Shell>
    )
  }

  const supabase = anonClient()
  const { data } = await supabase.rpc('unsubscribe_check', { p_token: token })
  const record = Array.isArray(data) ? data[0] : null

  if (!record?.found) {
    return (
      <Shell title="This link doesn’t look right">
        <p>
          It may have already been used, or the address may have been removed. Reply to the email
          and we’ll take care of it.
        </p>
      </Shell>
    )
  }

  if (done === '1' || record.already) {
    return (
      <Shell title="You’re unsubscribed">
        <p>
          {record.email ? <strong>{record.email}</strong> : 'That address'} won’t receive any more
          marketing email from us. You may still get replies to conversations you start, and
          anything to do with an order or an account.
        </p>
      </Shell>
    )
  }

  return (
    <Shell title="Unsubscribe">
      <p>
        Stop sending marketing email to{' '}
        {record.email ? <strong>{record.email}</strong> : 'this address'}?
      </p>
      <UnsubscribeForm token={token} />
      <p className="text-xs text-slate-500">
        This won’t affect replies to conversations you start with us, or anything about an order.
      </p>
    </Shell>
  )
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-16">
      <div className="card w-full max-w-md space-y-4 p-6">
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        <div className="space-y-3 text-sm text-slate-600">{children}</div>
      </div>
    </main>
  )
}
