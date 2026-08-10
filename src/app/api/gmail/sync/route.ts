import { NextResponse } from 'next/server'

import { createSupabaseAdminClient, type AppSupabaseClient } from '@/lib/supabase/server'
import { isSchedulerAuthorized, schedulerSecrets } from '@/lib/scheduler'
import { googleClientId, googleClientSecret, isGoogleConfigured } from '@/lib/env'
import { isTokenKeyConfigured, openToken } from '@/lib/crypto'
import { ingestMessages } from '@/lib/ingest'
import {
  GmailAuthError,
  HistoryExpiredError,
  backfillWindowStart,
  getMessage,
  getProfile,
  listHistory,
  listRecentMessageIds,
  parseGmailMessage,
  refreshAccessToken,
} from '@/lib/gmail'
import type { IncomingMessage } from '@/lib/sync'

/**
 * The poller. Point a scheduler at it every 5–15 minutes:
 *
 *   POST /api/gmail/sync
 *   Authorization: Bearer <SYNC_INGEST_SECRET or CRON_SECRET>
 *
 * Runs with the service role because it spans every organization and reads the
 * encrypted refresh tokens, which no user session can. It is safe to run more
 * often than needed and safe to re-run after a failure: ingestion is idempotent
 * on (organization, source, external id), and the cursor only advances after a
 * run that actually wrote its messages.
 */

/**
 * Ceilings per run, so one huge mailbox cannot starve the rest and a run stays
 * inside a serverless function's time limit. A backlog drains over successive
 * runs rather than in one heroic request.
 */
const MAX_MESSAGES_PER_RUN = 75
const MAX_CONNECTIONS_PER_RUN = 25
/** Gmail is happy with a handful of concurrent reads; this is not a stress test. */
const FETCH_CONCURRENCY = 5
/**
 * Below this, a backfill chunk is not worth starting. The walk moves its cursor
 * to the oldest message it fetched, so a chunk of one or two barely advances,
 * and a chunk of exactly one could re-fetch the same message forever if Gmail
 * treats `before:` as inclusive. Ten guarantees the boundary moves.
 */
const MIN_BACKFILL_CHUNK = 10

/** Long enough for a full run; the ceilings above are what keep it in bounds. */
export const maxDuration = 60

type Connection = {
  id: string
  organization_id: string
  email_address: string
  refresh_token: string | null
  history_id: string | null
  backfill_days: number
  backfill_until: string | null
}

type ConnectionResult = {
  mailbox: string
  logged?: number
  duplicates?: number
  unmatched?: number
  fetched?: number
  /** How many of this run's messages came from the history walk. */
  backfilled?: number
  /** How far back the walk has reached, or 'complete'. */
  history?: string
  /**
   * More new mail was waiting than one run takes. Routine and self-correcting:
   * the incremental cursor stopped short and the next run continues from there.
   */
  truncated?: boolean
  error?: string
  status?: string
}

export async function POST(request: Request) {
  if (schedulerSecrets().length === 0) {
    return NextResponse.json(
      { error: 'Sync is not configured (set SYNC_INGEST_SECRET or CRON_SECRET)' },
      { status: 503 },
    )
  }

  if (!isSchedulerAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isGoogleConfigured() || !isTokenKeyConfigured()) {
    return NextResponse.json(
      { error: 'Gmail sync is not configured (GOOGLE_CLIENT_ID / MAILBOX_TOKEN_KEY)' },
      { status: 503 },
    )
  }

  const supabase = createSupabaseAdminClient()

  // Least-recently-synced first, so a backlog drains evenly instead of the
  // same few mailboxes being polled every time.
  const { data, error } = await supabase
    .from('mailbox_connections')
    .select(
      'id, organization_id, email_address, refresh_token, history_id, backfill_days, backfill_until',
    )
    .eq('status', 'active')
    .eq('provider', 'gmail')
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(MAX_CONNECTIONS_PER_RUN)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: ConnectionResult[] = []
  for (const connection of (data ?? []) as Connection[]) {
    results.push(await syncConnection(supabase, connection))
  }

  return NextResponse.json({ connections: results.length, results })
}

/** Vercel Cron issues a GET, and a manual run from curl is easier as one too. */
export const GET = POST

async function syncConnection(
  supabase: AppSupabaseClient,
  connection: Connection,
): Promise<ConnectionResult> {
  const mailbox = connection.email_address

  if (!connection.refresh_token) {
    await markNeedsReauth(supabase, connection.id, 'No stored credentials — reconnect the mailbox')
    return { mailbox, status: 'needs_reauth', error: 'No stored credentials' }
  }

  let accessToken: string
  let anchorHistoryId: string | null = null

  try {
    accessToken = await refreshAccessToken({
      refreshToken: openToken(connection.refresh_token),
      clientId: googleClientId(),
      clientSecret: googleClientSecret(),
    })
    // Read the mailbox's current cursor *before* fetching anything. A backfill
    // has no history of its own to anchor to, and without this the connection
    // would backfill on every single run and never go incremental. Taking it
    // first also means mail arriving mid-run is picked up next time rather
    // than skipped.
    anchorHistoryId = (await getProfile(accessToken)).historyId || null
  } catch (thrown) {
    // A revoked grant will never succeed on a retry, so it stops the
    // connection rather than failing quietly every ten minutes forever.
    if (thrown instanceof GmailAuthError) {
      await markNeedsReauth(supabase, connection.id, thrown.message)
      return { mailbox, status: 'needs_reauth', error: thrown.message }
    }
    return await recordError(supabase, connection.id, mailbox, thrown)
  }

  /*
   * Two independent jobs, and keeping them apart is the point.
   *
   * Forwards: the incremental cursor, which delivers today's mail. It gets
   * first call on the run's budget, because new email is what the CRM is for.
   *
   * Backwards: the history walk, which takes whatever budget is left and moves
   * `backfill_until` a little further into the past each run. Importing a year
   * of archive therefore never delays this morning's email, and never has to
   * finish in one heroic request.
   */
  const windowStart = backfillWindowStart(connection.backfill_days)
  let backfillUntil = connection.backfill_until ? new Date(connection.backfill_until) : null
  let messageIds: string[] = []
  let backfillIds: string[] = []
  let nextHistoryId: string | null = null
  let truncated = false

  try {
    if (connection.history_id) {
      try {
        // The ceiling goes to listHistory rather than being applied to its
        // result, so the cursor it returns covers exactly these ids and no
        // more. Anything left over is picked up by the next run.
        const history = await listHistory(accessToken, connection.history_id, MAX_MESSAGES_PER_RUN)
        messageIds = history.messageIds
        nextHistoryId = history.historyId
        truncated = history.truncated
      } catch (thrown) {
        // Gmail keeps about a week of history. Once the cursor ages out, mail
        // from the gap is unreachable incrementally and silently stopping would
        // look exactly like "no new mail" — so re-anchor and reopen the walk,
        // which re-covers the window. Re-ingesting is free; missing is not.
        if (!(thrown instanceof HistoryExpiredError)) throw thrown
        nextHistoryId = anchorHistoryId
        backfillUntil = null
      }
    } else {
      // First run after connecting. Anchor forwards immediately so new mail is
      // never waiting on the archive, and let the walk below bring the history.
      nextHistoryId = anchorHistoryId
    }

    const budget = MAX_MESSAGES_PER_RUN - messageIds.length
    const walking = !backfillUntil || backfillUntil > windowStart

    if (walking && budget >= MIN_BACKFILL_CHUNK) {
      backfillIds = await listRecentMessageIds(
        accessToken,
        connection.backfill_days,
        budget,
        backfillUntil,
      )

      // Nothing older left in the window: the walk is done. Recorded as the
      // window edge rather than a flag, so widening the window on the Mailboxes
      // page starts it moving again by itself.
      if (backfillIds.length < budget) backfillUntil = windowStart
    }
  } catch (thrown) {
    if (thrown instanceof GmailAuthError) {
      await markNeedsReauth(supabase, connection.id, thrown.message)
      return { mailbox, status: 'needs_reauth', error: thrown.message }
    }
    return await recordError(supabase, connection.id, mailbox, thrown)
  }

  /*
   * Deliberately not sliced. Every producer above already bounded what it
   * returns, and the cursors stored below match those sets exactly — trimming
   * here would put them out of step again, which is the bug this replaced.
   */
  const backfillSet = new Set(backfillIds)
  const allIds = [...new Set([...messageIds, ...backfillIds])]
  const messages: IncomingMessage[] = []
  /*
   * The oldest thing the walk actually reached, taken from Gmail's own
   * timestamp rather than from the parsed result — a chunk of nothing but
   * drafts and spam parses to nothing at all, and a cursor derived from the
   * parsed messages would then never move and the walk would stall on the same
   * window forever.
   */
  let oldestWalked: number | null = null

  try {
    for (let i = 0; i < allIds.length; i += FETCH_CONCURRENCY) {
      const batch = await Promise.all(
        allIds.slice(i, i + FETCH_CONCURRENCY).map((id) => getMessage(accessToken, id)),
      )

      for (const raw of batch) {
        if (!raw) continue

        if (raw.id && backfillSet.has(raw.id) && raw.internalDate) {
          const at = Number(raw.internalDate)
          if (Number.isFinite(at) && (oldestWalked === null || at < oldestWalked)) oldestWalked = at
        }

        const parsed = parseGmailMessage(raw, mailbox)
        if (parsed) messages.push(parsed)
      }
    }
  } catch (thrown) {
    if (thrown instanceof GmailAuthError) {
      await markNeedsReauth(supabase, connection.id, thrown.message)
      return { mailbox, status: 'needs_reauth', error: thrown.message }
    }
    return await recordError(supabase, connection.id, mailbox, thrown)
  }

  let result
  try {
    result = await ingestMessages(supabase, connection.organization_id, messages)
  } catch (thrown) {
    return await recordError(supabase, connection.id, mailbox, thrown)
  }

  /*
   * Both cursors advance only now, after the messages are written. If anything
   * above failed, the next run repeats this window — which is free, because
   * re-ingesting the same message is a no-op.
   *
   * If the forward anchor could not be read the cursor stays null and the next
   * run anchors instead; the walk meanwhile continues from where it got to.
   */
  const update: Record<string, unknown> = {
    last_synced_at: new Date().toISOString(),
    last_error: null,
  }

  if (nextHistoryId) update.history_id = nextHistoryId

  /*
   * The walk moves to the oldest message it actually read. Gmail may hand that
   * same message back next time if it treats `before:` as inclusive, which is
   * why a chunk is never started below MIN_BACKFILL_CHUNK — a boundary that
   * cannot move is a walk that never ends.
   */
  if (oldestWalked !== null && (!backfillUntil || oldestWalked < backfillUntil.getTime())) {
    backfillUntil = new Date(oldestWalked)
  }

  if (backfillUntil) update.backfill_until = backfillUntil.toISOString()

  if (result.logged > 0) {
    const { data: current } = await supabase
      .from('mailbox_connections')
      .select('messages_logged')
      .eq('id', connection.id)
      .maybeSingle()

    update.messages_logged = Number(current?.messages_logged ?? 0) + result.logged
  }

  await supabase.from('mailbox_connections').update(update).eq('id', connection.id)

  return {
    mailbox,
    fetched: messages.length,
    backfilled: backfillIds.length,
    history:
      backfillUntil && backfillUntil <= windowStart
        ? 'complete'
        : (backfillUntil?.toISOString() ?? 'not started'),
    truncated,
    ...result,
  }
}

/**
 * The cursor is kept, not cleared. Under a Testing-mode consent screen a grant
 * expires every seven days, so this state is a weekly routine rather than a
 * catastrophe, and someone who reconnects the same day should resume where they
 * left off instead of re-scanning a month of mail. If the cursor has genuinely
 * aged out by then, the poller's own 404 handling falls back to a backfill —
 * so keeping it can only save work, never skip mail.
 */
async function markNeedsReauth(supabase: AppSupabaseClient, id: string, reason: string) {
  await supabase
    .from('mailbox_connections')
    .update({ status: 'needs_reauth', last_error: reason })
    .eq('id', id)
}

async function recordError(
  supabase: AppSupabaseClient,
  id: string,
  mailbox: string,
  thrown: unknown,
): Promise<ConnectionResult> {
  const message = thrown instanceof Error ? thrown.message : 'Sync failed'
  // Recorded but not fatal: the connection stays active and the next run tries
  // again from the same cursor.
  await supabase.from('mailbox_connections').update({ last_error: message }).eq('id', id)
  return { mailbox, error: message }
}
