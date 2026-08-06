import { NextResponse, type NextRequest } from 'next/server'

import { createSupabaseServerClient } from '@/lib/supabase/server'

/**
 * Exchanges the magic-link / OAuth code for a session cookie, then stamps
 * last_login_at on the CRM user record.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing-code`)
  }

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`)
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    await supabase
      .from('users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('auth_provider_id', user.id)
  }

  return NextResponse.redirect(`${origin}${next.startsWith('/') ? next : '/'}`)
}
