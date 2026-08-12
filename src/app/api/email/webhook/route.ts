import { NextResponse } from 'next/server'

import { createSupabaseAdminClient } from '@/lib/supabase/server'
import { resendWebhookSecret } from '@/lib/env'
import { verifyResendWebhook } from '@/lib/email/webhook'

/**
 * What the provider tells us after a message leaves.
 *
 *   POST /api/email/webhook
 *   svix-id / svix-timestamp / svix-signature
 *
 * Delivered, opened, clicked, bounced, complained. The first three are
 * reporting. The last two are the ones that matter: a hard bounce or a spam
 * complaint writes a suppression, and that address is never sent to again by
 * anything in the CRM. Leaving that to somebody to notice in a dashboard means
 * it never happens, and continuing to mail an address that bounced is how a
 * sending domain's reputation is destroyed.
 *
 * Configure it in Resend under Webhooks, pointing at this URL, and put the
 * signing secret in RESEND_WEBHOOK_SECRET.
 */
export async function POST(request: Request) {
  const secret = resendWebhookSecret()
  if (!secret) {
    return NextResponse.json({ error: 'RESEND_WEBHOOK_SECRET is not set.' }, { status: 503 })
  }

  // The bytes as they arrived. Parsing first and re-serialising would change
  // the JSON, and the signature is over the original.
  const body = await request.text()

  const verified = verifyResendWebhook(request.headers, body, secret)
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 401 })
  }

  let payload: {
    type?: string
    data?: { email_id?: string; to?: string[] | string }
  }
  try {
    payload = JSON.parse(body)
  } catch {
    return NextResponse.json({ error: 'Body is not JSON' }, { status: 400 })
  }

  if (!payload.type) {
    return NextResponse.json({ error: 'No event type' }, { status: 400 })
  }

  const to = Array.isArray(payload.data?.to) ? payload.data?.to[0] : payload.data?.to

  const supabase = createSupabaseAdminClient()
  const { error } = await supabase.rpc('record_email_event', {
    p_provider_id: payload.data?.email_id ?? null,
    p_event_type: payload.type,
    p_recipient: to ?? null,
    p_payload: JSON.parse(body),
  })

  if (error) {
    /*
     * A 500 here is deliberate: Svix retries on one, and losing a bounce means
     * mailing a dead address forever. An event we cannot record is worth being
     * sent again.
     */
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
