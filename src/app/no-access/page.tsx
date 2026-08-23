import { redirect } from 'next/navigation'

import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getAuthUser, getSessionContext } from '@/lib/tenancy'

export const metadata = { title: 'No access · FLO CRM' }

/**
 * Signed in with Supabase Auth, but with no organization to be in.
 *
 * There are two ways to arrive here and they need different sentences. Not
 * being provisioned yet (PRD 1.3: organizations and users are created by an
 * internal admin) is answered by asking an administrator. An organization that
 * has been suspended is not — telling those people to ask for an invitation
 * sends them to somebody who will find them already invited, and they will be
 * back here an afternoon later none the wiser.
 *
 * The reason cannot be read off the tables: current_org_id() is null in both
 * cases, so the user's own row is unreadable through the policies. That is the
 * enforcement working, not a gap. access_denied_reason() answers the single
 * question as definer, about the caller and nobody else, and returns a reason
 * rather than a name — somebody turned away learns why, and nothing about the
 * organization that turned them away.
 */

type DeniedReason =
  | 'not_signed_in'
  | 'none'
  | 'organization_inactive'
  | 'user_not_active'
  | 'no_membership'

export default async function NoAccessPage() {
  const context = await getSessionContext()
  if (context) redirect('/')

  const authUser = await getAuthUser()
  if (!authUser) redirect('/login')

  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.rpc('access_denied_reason')
  const reason = (data as DeniedReason | null) ?? 'no_membership'

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card max-w-md p-6 text-sm text-slate-600">
        <h1 className="text-lg font-semibold text-slate-900">{TITLES[reason] ?? TITLES.no_membership}</h1>

        <p className="mt-3">
          You are signed in as <span className="font-medium text-slate-900">{authUser.email}</span>.
        </p>

        {reason === 'organization_inactive' ? (
          <>
            <p className="mt-2">
              Your account is there and your access is intact — the organization it belongs to has
              been switched off, so nobody in it can sign in at the moment.
            </p>
            <p className="mt-2">
              Nothing has been deleted. Ask whoever administers your organization to make it active
              again, and everything will be exactly where you left it.
            </p>
          </>
        ) : reason === 'user_not_active' ? (
          <p className="mt-2">
            That address has an account, but it is not active yet. If you were invited recently, the
            invitation may still be waiting — ask an administrator to check{' '}
            <span className="font-medium">Settings → Users</span>.
          </p>
        ) : (
          <>
            <p className="mt-2">
              That address has not been added to an organization yet.
            </p>
            <p className="mt-2">
              Ask an administrator to invite you from{' '}
              <span className="font-medium">Settings → Users</span> with this exact email address,
              then sign in again.
            </p>
          </>
        )}

        <form action="/auth/signout" method="post" className="mt-5">
          <button type="submit" className="btn-secondary">
            Sign out
          </button>
        </form>
      </div>
    </main>
  )
}

const TITLES: Record<DeniedReason, string> = {
  not_signed_in: 'No organization access',
  none: 'No organization access',
  no_membership: 'No organization access',
  user_not_active: 'Your account is not active yet',
  organization_inactive: 'This organization is switched off',
}
