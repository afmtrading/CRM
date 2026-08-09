import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'

import { requireSession } from '@/lib/tenancy'
import { googleClientId, googleRedirectUri, isGoogleConfigured } from '@/lib/env'
import { isTokenKeyConfigured } from '@/lib/crypto'
import { buildAuthUrl } from '@/lib/gmail'

/**
 * GET /api/gmail/connect — starts the consent flow for the signed-in user.
 *
 * The state parameter is a random nonce echoed back by Google and compared
 * against an httpOnly cookie. Without it, a link crafted by someone else could
 * complete the flow in a victim's browser and attach an attacker's mailbox to
 * their account.
 *
 * A person connects their own mailbox and nobody else's; the callback reads the
 * user from the session, never from the request.
 */
export async function GET() {
  const context = await requireSession()

  if (!isGoogleConfigured() || !isTokenKeyConfigured()) {
    return NextResponse.redirect(
      new URL('/settings/mailboxes?error=not-configured', googleRedirectUri()),
    )
  }

  if (!context.canWrite) {
    return NextResponse.redirect(
      new URL('/settings/mailboxes?error=permission', googleRedirectUri()),
    )
  }

  const state = randomBytes(24).toString('base64url')

  const response = NextResponse.redirect(
    buildAuthUrl({
      clientId: googleClientId(),
      redirectUri: googleRedirectUri(),
      state,
      // Nudges Google towards the right account when someone is signed into
      // several. They can still pick another.
      loginHint: context.user.email,
    }),
  )

  response.cookies.set('gmail_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/gmail',
    maxAge: 600,
  })

  return response
}
