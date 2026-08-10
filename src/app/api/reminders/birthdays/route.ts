import { NextResponse } from 'next/server'

import { createSupabaseAdminClient } from '@/lib/supabase/server'
import { isSchedulerAuthorized, schedulerSecrets } from '@/lib/scheduler'

/**
 * Creates the birthday reminder tasks that are due, across every organization.
 *
 * Authenticated with the same shared secret as the sync endpoint rather than a
 * user session, because a scheduled job has no session. Off until
 * SYNC_INGEST_SECRET is configured.
 *
 *   POST /api/reminders/birthdays
 *   Authorization: Bearer <SYNC_INGEST_SECRET>
 *
 * The underlying function is idempotent, so running it more than once a day —
 * or retrying a failed run — cannot produce duplicate tasks. Point a daily
 * scheduler at it (Vercel Cron, or `select create_birthday_reminders();` from
 * pg_cron).
 */
export async function POST(request: Request) {
  if (schedulerSecrets().length === 0) {
    return NextResponse.json(
      { error: 'Reminders are not configured. Set SYNC_INGEST_SECRET or CRON_SECRET.' },
      { status: 503 },
    )
  }

  if (!isSchedulerAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const daysAhead = Number(new URL(request.url).searchParams.get('days') ?? 3)
  if (!Number.isInteger(daysAhead) || daysAhead < 0 || daysAhead > 365) {
    return NextResponse.json({ error: 'days must be an integer between 0 and 365' }, { status: 400 })
  }

  // Runs with the service role: the job spans every organization, and the
  // function itself scopes each task to the contact's own organization.
  const supabase = createSupabaseAdminClient()
  const { data, error } = await supabase.rpc('create_birthday_reminders', {
    p_days_ahead: daysAhead,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ created: data ?? 0, daysAhead })
}

/** Vercel Cron issues a GET. */
export const GET = POST
