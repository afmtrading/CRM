import { NextResponse } from 'next/server'

import { createSupabaseAdminClient } from '@/lib/supabase/server'
import { isSchedulerAuthorized, schedulerSecrets } from '@/lib/scheduler'
import { isEmailConfigured } from '@/lib/env'
import { applyMergeFields, renderEmail } from '@/lib/email/render'
import { sendEmail, unsubscribeUrlFor } from '@/lib/email/send'
import type { ClaimedRecipientRow } from '@/lib/database.types'

/**
 * The drain.
 *
 *   POST /api/campaigns/send
 *   Authorization: Bearer <CRON_SECRET or SYNC_INGEST_SECRET>
 *
 * Scheduling a campaign does not send anything — it writes one row per
 * recipient. This route takes a batch of those rows, sends them, and marks what
 * happened. Everything good about that arrangement follows from it: a crashed
 * run resumes where it stopped, a retry cannot double-send because the rows
 * remember, and a campaign of ten thousand is simply more runs rather than one
 * request that times out.
 *
 * It runs with the service role because it spans every organization and has no
 * session to run as. Which is also why the claim function is the only thing it
 * is allowed to call: no signed-in user can reach these functions at all.
 */

/**
 * How many messages one run sends.
 *
 * Chosen against the wall clock, not the provider's limits: Resend is happy
 * with far more, but a serverless function is not. Fifty sends sequentially in
 * well under the timeout with room for a slow one, and the backlog is drained
 * by the next run a minute later rather than by making this one heroic.
 */
const BATCH_SIZE = 50

/** Long enough for the batch above, with the ceiling doing the real limiting. */
export const maxDuration = 60

type Outcome = {
  sent: number
  failed: number
  skipped: number
  errors: string[]
}

export async function POST(request: Request) {
  if (schedulerSecrets().length === 0) {
    return NextResponse.json(
      { error: 'Sending is not configured. Set CRON_SECRET or SYNC_INGEST_SECRET.' },
      { status: 503 },
    )
  }

  if (!isSchedulerAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isEmailConfigured()) {
    return NextResponse.json({ error: 'RESEND_API_KEY is not set.' }, { status: 503 })
  }

  const supabase = createSupabaseAdminClient()

  /*
   * Suspended accounts drop out before anything else happens.
   *
   * This runs with the service role, which bypasses RLS — so the enforcement
   * that stops a suspended organization elsewhere in the app does not reach
   * here, and without this an account switched off on Friday would spend the
   * weekend mailing its customers. Anything in flight becomes 'paused', which
   * keeps the outbox intact: nobody is half-mailed, and coming back is a person
   * pressing resume rather than a surprise.
   */
  const { data: paused, error: pauseError } = await supabase.rpc('pause_suspended_campaigns')
  if (pauseError) {
    return NextResponse.json({ error: pauseError.message }, { status: 500 })
  }

  // Anything whose time has come becomes 'sending' first, so this run picks it
  // up rather than the next one. Idempotent: a campaign already sending is not
  // matched — and a suspended account's is not started at all.
  const { data: started, error: startError } = await supabase.rpc('start_due_campaigns')
  if (startError) {
    return NextResponse.json({ error: startError.message }, { status: 500 })
  }

  const limit = Math.min(
    Math.max(Number(new URL(request.url).searchParams.get('limit') ?? BATCH_SIZE) || BATCH_SIZE, 1),
    200,
  )

  const { data: claimed, error: claimError } = await supabase.rpc('claim_campaign_batch', {
    p_limit: limit,
  })
  if (claimError) {
    return NextResponse.json({ error: claimError.message }, { status: 500 })
  }

  const batch = (claimed ?? []) as ClaimedRecipientRow[]
  const outcome: Outcome = { sent: 0, failed: 0, skipped: 0, errors: [] }

  /*
   * Sequential rather than concurrent. A campaign is not latency-sensitive —
   * nobody is waiting on the tenth message of a batch — and sending in order at
   * a steady rate is what a receiving mail server reads as a legitimate sender
   * rather than a burst. The schedule provides the throughput; this provides
   * the manners.
   */
  for (const row of batch) {
    const result = await deliver(row)

    if (result.kind === 'skipped') {
      outcome.skipped += 1
      await supabase.rpc('finish_campaign_recipient', {
        p_recipient_id: row.recipient_id,
        p_status: 'skipped',
        p_skip_reason: result.reason,
      })
      continue
    }

    if (result.kind === 'failed') {
      outcome.failed += 1
      if (outcome.errors.length < 5) outcome.errors.push(result.error)
      await supabase.rpc('finish_campaign_recipient', {
        p_recipient_id: row.recipient_id,
        p_status: 'failed',
        p_error: result.error,
      })
      continue
    }

    outcome.sent += 1
    await supabase.rpc('finish_campaign_recipient', {
      p_recipient_id: row.recipient_id,
      p_status: 'sent',
      p_provider_id: result.providerId ?? null,
    })
  }

  // A campaign is finished when its outbox is empty, which is a question the
  // outbox answers — so ask after every batch rather than counting up front.
  const { data: settled } = await supabase.rpc('settle_campaigns')

  return NextResponse.json({
    // Reported rather than silent: a run that pauses campaigns is a run where
    // an account was switched off, and that should be visible in the cron log
    // rather than inferred from a send count quietly dropping to zero.
    paused: paused ?? 0,
    started: started ?? 0,
    claimed: batch.length,
    ...outcome,
    finished: settled ?? 0,
    // True when there was a full batch waiting, which is the caller's cue that
    // more is left. Vercel Cron ignores it; a manual drain can loop on it.
    more: batch.length === limit,
  })
}

/** Vercel Cron issues a GET. */
export const GET = POST

type Delivery =
  | { kind: 'sent'; providerId?: string }
  | { kind: 'failed'; error: string }
  | { kind: 'skipped'; reason: string }

/**
 * One message.
 *
 * The checks here are not belt-and-braces — each catches something the audience
 * build could not have known. Consent is re-read at claim time because somebody
 * may have unsubscribed in the hours since; the sender may have been taken
 * apart in settings; and a contact with no unsubscribe token cannot be sent a
 * message with a working unsubscribe link, which is not a message we send.
 */
async function deliver(row: ClaimedRecipientRow): Promise<Delivery> {
  // Re-checked at the moment of sending. Mailing somebody who unsubscribed
  // while the campaign was queued is precisely the failure that matters.
  if (row.blocked_reason) {
    return { kind: 'skipped', reason: row.blocked_reason }
  }

  if (!row.email) {
    return { kind: 'skipped', reason: 'no_email' }
  }

  if (!row.from_address || !row.from_name) {
    return { kind: 'failed', error: 'No sending domain is configured for this organization' }
  }

  if (!row.unsubscribe_token) {
    return { kind: 'skipped', reason: 'no_unsubscribe_token' }
  }

  const unsubscribeUrl = unsubscribeUrlFor(row.unsubscribe_token)

  const body = applyMergeFields(row.body, {
    first_name: row.first_name ?? 'there',
    last_name: row.last_name ?? '',
    company: row.company_name ?? '',
    email: row.email,
  })

  let rendered
  try {
    rendered = renderEmail({
      subject: applyMergeFields(row.subject, {
        first_name: row.first_name ?? 'there',
        last_name: row.last_name ?? '',
        company: row.company_name ?? '',
        email: row.email,
      }),
      body,
      // The name the recipient knows the sender by, not the organization's
      // internal label — the footer says who the message is from.
      organizationName: row.from_name,
      logoUrl: row.logo_url,
      postalAddress: row.postal_address,
      unsubscribeUrl,
    })
  } catch (error) {
    return {
      kind: 'failed',
      error: error instanceof Error ? error.message : 'The message could not be rendered',
    }
  }

  const result = await sendEmail({
    ...rendered,
    to: row.email,
    from: { name: row.from_name, address: row.from_address },
    replyTo: row.reply_to,
    unsubscribeUrl,
  })

  return result.ok
    ? { kind: 'sent', providerId: result.id }
    : { kind: 'failed', error: result.error ?? 'The provider refused the message' }
}
