import { CallbackHandler } from './callback-handler'

export const metadata = { title: 'Signing in · FLO CRM' }

export default async function AuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const params = await searchParams
  // Only ever a path inside this app: an open redirect here would be a way to
  // bounce somebody straight from a trusted sign-in link to anywhere at all.
  const next = params.next?.startsWith('/') ? params.next : '/'

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-lg font-bold text-white shadow-sm">
            F
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">FLO CRM</h1>
        </div>

        <CallbackHandler next={next} />
      </div>
    </main>
  )
}
