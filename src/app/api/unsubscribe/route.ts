import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from '@/lib/env'

/**
 * One-click unsubscribe, for the button an inbox draws itself.
 *
 * This is the endpoint named in the `List-Unsubscribe-Post` header, and it is
 * the reason that header can say `One-Click`: Gmail and Yahoo POST here on the
 * recipient's behalf when they press Unsubscribe in the inbox chrome, and
 * expect it to be done with no further interaction.
 *
 * That is the opposite of what the `/unsubscribe` page does, and deliberately
 * so. A page reached by GET must not act, because link scanners follow links.
 * A POST is not something a scanner does, and RFC 8058 defines this exact
 * shape — so acting immediately here is correct, and asking for confirmation
 * would break the feature.
 *
 * The prize is real: this button is what people press instead of "report
 * spam", and a complaint costs the sending domain far more than an unsubscribe.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  /*
   * The token may arrive in the query string or the posted form, because mail
   * clients differ on which they use. Both are read rather than guessing.
   */
  const fromQuery = request.nextUrl.searchParams.get('t')
  let fromBody: string | null = null

  try {
    const form = await request.formData()
    const value = form.get('t')
    fromBody = typeof value === 'string' ? value : null
  } catch {
    // A body-less POST is normal here; the token is then in the URL.
  }

  const token = [fromQuery, fromBody].find((value) => value && UUID.test(value)) ?? null

  if (!token) {
    return NextResponse.json({ error: 'missing token' }, { status: 400 })
  }

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: { getAll: () => [], setAll: () => {} },
  })

  const { data, error } = await supabase.rpc('unsubscribe_by_token', { p_token: token })

  if (error) {
    return NextResponse.json({ error: 'could not unsubscribe' }, { status: 500 })
  }

  /*
   * A token nobody was issued gets a 200 as well. The mail client is not the
   * person, there is nothing for it to do differently, and answering 404 would
   * tell whoever sent it which tokens are real.
   */
  return NextResponse.json({ ok: true, unsubscribed: data === true })
}
