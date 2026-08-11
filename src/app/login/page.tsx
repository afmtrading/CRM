import { isSupabaseConfigured } from '@/lib/env'

import { LoginForm } from './login-form'

export const metadata = { title: 'Sign in · FLO CRM' }

/**
 * Raw slugs used to reach the page and be shown to the person as-is.
 * "missing-code" is not an explanation of anything.
 */
const ERRORS: Record<string, string> = {
  'missing-code': 'That sign-in link could not be read. Ask for a fresh one below.',
  'auth-required': 'Sign in to continue.',
  expired: 'That sign-in link has expired. Ask for a fresh one below.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const params = await searchParams
  const configured = isSupabaseConfigured()

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-lg font-bold text-white shadow-sm">
            F
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">FLO CRM</h1>
          <p className="mt-1.5 text-sm text-slate-500">Sign in to your organization</p>
        </div>

        {configured ? (
          <LoginForm
            next={params.next}
            initialError={params.error ? (ERRORS[params.error] ?? params.error) : undefined}
          />
        ) : (
          <div className="card p-4 text-sm text-slate-600">
            <p className="font-medium text-slate-900">Supabase is not configured</p>
            <p className="mt-2">
              Set <code className="rounded bg-slate-100 px-1">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
              <code className="rounded bg-slate-100 px-1">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in the
              environment, then reload. See <code className="rounded bg-slate-100 px-1">README.md</code>.
            </p>
          </div>
        )}

        <p className="mt-6 text-center text-xs text-slate-400">
          Accounts are provisioned by an administrator. There is no public signup.
        </p>
      </div>
    </main>
  )
}
