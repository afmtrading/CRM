import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Checking that a webhook really came from Resend.
 *
 * A webhook endpoint is a URL anybody can POST to. Without a signature check it
 * is an open invitation to mark any address as bounced — which, because a
 * bounce writes a suppression, would let a stranger quietly stop us mailing
 * whoever they liked. So this is not paperwork; it is the whole security model
 * of the endpoint.
 *
 * Resend signs with Svix. The scheme is small enough to implement directly, and
 * doing so avoids a dependency whose only job is thirty lines of HMAC:
 *
 *   secret     "whsec_<base64>" — everything after the prefix is the real key
 *   signed     "<svix-id>.<svix-timestamp>.<raw body>"
 *   header     "v1,<base64> v1,<base64> …" — several, because a secret being
 *              rotated is signed with both the old key and the new one
 *
 * The body must be the bytes as they arrived. Parsing the JSON and
 * re-serialising it changes key order and whitespace, and the signature is over
 * the original — this is the classic way a verification silently never matches.
 */

/** How far out of date a message may be. Svix's own default. */
const TOLERANCE_SECONDS = 5 * 60

export type VerificationResult = { ok: true } | { ok: false; reason: string }

export function verifyResendWebhook(
  headers: Headers,
  body: string,
  secret: string,
): VerificationResult {
  const id = headers.get('svix-id')
  const timestamp = headers.get('svix-timestamp')
  const signature = headers.get('svix-signature')

  if (!id || !timestamp || !signature) {
    return { ok: false, reason: 'Missing signature headers' }
  }

  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt)) {
    return { ok: false, reason: 'Bad timestamp' }
  }

  /*
   * The timestamp is what stops a replay: a signature stays valid forever, so
   * without this, one captured "bounced" event could be posted back a thousand
   * times a year from now.
   */
  const age = Math.abs(Date.now() / 1000 - sentAt)
  if (age > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'Timestamp outside the tolerance window' }
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  if (key.length === 0) {
    return { ok: false, reason: 'The webhook secret is empty' }
  }

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest()

  // Several, because a rotation signs with both keys for a while.
  const offered = signature
    .split(' ')
    .map((part) => part.split(','))
    .filter(([version]) => version === 'v1')
    .map(([, value]) => value)

  for (const candidate of offered) {
    if (!candidate) continue
    const bytes = Buffer.from(candidate, 'base64')
    // Constant time, and only after the lengths match — timingSafeEqual throws
    // on a mismatch rather than returning false, which would be a crash on
    // input a stranger controls.
    if (bytes.length === expected.length && timingSafeEqual(bytes, expected)) {
      return { ok: true }
    }
  }

  return { ok: false, reason: 'No signature matched' }
}
