import { SetPasswordForm } from './set-password-form'

export const metadata = { title: 'Choose a password · FLO CRM' }

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const params = await searchParams
  const next = params.next?.startsWith('/') ? params.next : '/'

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-lg font-bold text-white shadow-sm">
            F
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Welcome to FLO CRM</h1>
          <p className="mt-1.5 text-sm text-slate-500">One step and you are in</p>
        </div>

        <SetPasswordForm next={next} />
      </div>
    </main>
  )
}
