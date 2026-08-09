import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import { requireSession } from '@/lib/tenancy'
import { createSupabaseAdminClient } from '@/lib/supabase/server'
import {
  googleClientId,
  googleClientSecret,
  googleRedirectUri,
  isGoogleConfigured,
  siteUrl,
} from '@/lib/env'
import { isTokenKeyConfigured, safeEquals, sealToken } from '@/lib/crypto'
import { exchangeCode, getProfile } from '@/lib/gmail'

/**
 * GET /api/gmail/callback — finishes the consent flow.
 *
 * Writes with the service-role client because `authenticated` has no write
 * grant on mailbox_connections at all, and no grant whatsoever on the token
 * column. The organization and user are taken from the session, not the
 * request, so the elevated client cannot be steered at someone else's row.
 *
 * history_id is deliberately left null: the first sync then backfills the
 * connection's window rather than starting from this instant, so connecting a
 * mailbox brings recent correspondence with it.
 */
function back(params: Record<string, string>) {
  const url = new URL('/settings/mailboxes', siteUrl())
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  const context = await requireSession()

  if (!isGoogleConfigured() || !isTokenKeyConfigured()) {
    return back({ error: 'not-configured' })
  }

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const denied = url.searchParams.get('error')

  const jar = await cookies()
  const expected = jar.get('gmail_oauth_state')?.value
  // One-shot: cleared whether the flow succeeds or fails, so a captured state
  // value cannot be replayed.
  jar.delete('gmail_oauth_state')

  if (denied) return back({ error: 'denied' })
  if (!code || !state || !expected || !safeEquals(state, expected)) {
    return back({ error: 'state' })
  }

  let accessToken: string
  let refreshToken: string | null

  try {
    const tokens = await exchangeCode({
      code,
      clientId: googleClientId(),
      clientSecret: googleClientSecret(),
      redirectUri: googleRedirectUri(),
    })
    accessToken = tokens.accessToken
    refreshToken = tokens.refreshToken
  } catch {
    return back({ error: 'exchange' })
  }

  // Without a refresh token the connection would work until the access token
  // expires in an hour and then stop, which is worse than not connecting.
  if (!refreshToken) return back({ error: 'no-refresh-token' })

  let emailAddress: string
  try {
    ;({ emailAddress } = await getProfile(accessToken))
  } catch {
    return back({ error: 'profile' })
  }

  if (!emailAddress) return back({ error: 'profile' })

  const supabase = createSupabaseAdminClient()

  const { error } = await supabase.from('mailbox_connections').upsert(
    {
      organization_id: context.organizationId,
      user_id: context.user.id,
      provider: 'gmail',
      email_address: emailAddress.toLowerCase(),
      refresh_token: sealToken(refreshToken),
      history_id: null,
      status: 'active',
      last_error: null,
    },
    { onConflict: 'organization_id,provider,email_address' },
  )

  if (error) return back({ error: 'save' })

  return back({ connected: emailAddress })
}
