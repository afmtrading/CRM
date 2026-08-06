import { redirect } from 'next/navigation'

import { getAuthUser, getSessionContext } from '@/lib/tenancy'

export const metadata = { title: 'No access · FLO CRM' }

/**
 * Signed in with Supabase Auth, but not provisioned into any organization.
 * PRD 1.3: organizations and users are created by an internal admin, so the
 * only route forward is asking one.
 */
export default async function NoAccessPage() {
  const context = await getSessionContext()
  if (context) redirect('/')

  const authUser = await getAuthUser()
  if (!authUser) redirect('/login')

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card max-w-md p-6 text-sm text-slate-600">
        <h1 className="text-lg font-semibold text-slate-900">No organization access</h1>
        <p className="mt-3">
          You are signed in as <span className="font-medium text-slate-900">{authUser.email}</span>,
          but that address has not been added to an organization yet.
        </p>
        <p className="mt-2">
          Ask an administrator to invite you from <span className="font-medium">Settings → Users</span>{' '}
          with this exact email address, then sign in again.
        </p>
        <form action="/auth/signout" method="post" className="mt-5">
          <button type="submit" className="btn-secondary">
            Sign out
          </button>
        </form>
      </div>
    </main>
  )
}
