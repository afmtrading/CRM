import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from '@/lib/env'

const PUBLIC_PATHS = ['/login', '/auth', '/api/health']

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
