import { NextResponse } from 'next/server'

import { createSupabaseServerClient } from '@/lib/supabase/server'

/**
 * Records that somebody just signed in.
 *
 * Its own endpoint because the sign-in itself now completes in the browser —
 * a session in a URL fragment is not readable anywhere else — and the CRM's
 * `last_login_at` still wants stamping from a request that carries the fresh
 * cookies. Writes nothing but the timestamp, and only for the caller's own
 * row: the update is keyed on the authenticated user's id, not on anything in
 * the request.
 */
export async function POST() {
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ ok: false }, { status: 401 })

  await supabase
    .from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('auth_provider_id', user.id)

  return NextResponse.json({ ok: true })
}
