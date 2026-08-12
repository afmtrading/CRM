import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from '@/lib/env'

/*
 * '/unsubscribe' is public on purpose. The person clicking has no account and
 * must not need one — their unsubscribe token is the whole authorisation, and
 * requiring a sign-in to honour a request to stop would be both hostile and,
 * where anti-spam law applies, non-compliant.
 */
/*
 * The scheduled and provider-callback endpoints below are public to *this*
 * gate and not to the world: each one authenticates its caller itself, with a
 * shared secret or a signed payload, and refuses to run without it. They have
 * to be listed here because they are called by machines that have no session —
 * Vercel Cron, and Resend's webhook — and a redirect to /login is not something
 * either of them can follow. Left unlisted, they do not fail loudly; they
 * quietly return a 307 to a sign-in page and never run at all.
 */
const SCHEDULED_PATHS = [
  '/api/gmail/sync',
  '/api/reminders',
  '/api/campaigns/send',
  '/api/email/webhook',
]

const PUBLIC_PATHS = [
  '/login',
  '/auth',
  '/api/health',
  '/unsubscribe',
  // The one-click endpoint a mail client POSTs to on the recipient's behalf.
  '/api/unsubscribe',
  ...SCHEDULED_PATHS,
]

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * Refreshes the Supabase session on every request and gates the whole app
 * behind a signed-in session. Authorisation *within* an organization is the
 * job of RLS plus the tenancy helper; this only answers "is anyone here".
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  if (!isSupabaseConfigured()) {
    return response
  }

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
      },
    },
  })

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}
