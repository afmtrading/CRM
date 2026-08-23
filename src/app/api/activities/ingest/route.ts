import { NextResponse } from 'next/server'
import { z } from 'zod'

import { createSupabaseAdminClient } from '@/lib/supabase/server'
import { ingestMessages } from '@/lib/ingest'
import type { IncomingMessage } from '@/lib/sync'

/**
 * POST /activities/ingest — the CRM side of the mailbox sync (6.4).
 *
 * An external connector posts what it finds here. The built-in Gmail poller
 * does not use this route: it calls ingestMessages() directly, since it already
 * runs inside the app. Both share the same matching and idempotency rules.
 *
 * Security notes, because this route deliberately runs outside a user session:
 *  - It authenticates with a shared secret, not a user JWT, since a background
 *    job has no session.
 *  - It therefore uses the service-role client, which bypasses RLS. The
 *    organization is taken from the request and every lookup and write is
 *    filtered to it explicitly — see the note in lib/ingest.ts.
 *  - Re-delivering the same message is a no-op: (organization_id,
 *    external_source, external_id) is unique, and the upsert is idempotent.
 */

const messageSchema = z.object({
  source: z.string().min(1).max(60),
  externalId: z.string().min(1).max(400),
  type: z.enum(['email', 'meeting']),
  subject: z.string().max(500).default(''),
  body: z.string().max(50_000).nullable().optional(),
  mailboxAddress: z.string().email(),
  from: z.string().max(320).nullable().optional(),
  to: z.array(z.string().max(320)).default([]),
  cc: z.array(z.string().max(320)).default([]),
  attendees: z.array(z.string().max(320)).default([]),
  occurredAt: z.string().datetime(),
})

const requestSchema = z.object({
  organization_slug: z.string().min(1).max(120),
  messages: z.array(messageSchema).max(500),
})

export async function POST(request: Request) {
  const secret = process.env.SYNC_INGEST_SECRET

  if (!secret) {
    return NextResponse.json(
      { error: 'Sync ingestion is not configured (SYNC_INGEST_SECRET is unset)' },
      { status: 503 },
    )
  }

  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 })
  }

  const { organization_slug: slug, messages } = parsed.data
  const supabase = createSupabaseAdminClient()

  const { data: organization } = await supabase
    .from('organizations')
    .select('id, status')
    .eq('slug', slug)
    .maybeSingle()

  if (!organization) {
    return NextResponse.json({ error: `Unknown organization "${slug}"` }, { status: 404 })
  }

  /*
   * A suspended account accepts nothing. This route runs with the service role
   * and so is not covered by the check in current_org_id() — without this, a
   * connector would carry on filing activity against records nobody in that
   * organization can open.
   *
   * 409 rather than 404: the organization exists and the caller's credentials
   * are fine, so telling them it is unknown would send whoever runs the
   * connector looking for a typo. It is also a state that resolves by itself if
   * the account comes back, which is what makes a conflict the honest code —
   * and a well-behaved connector will retry rather than discard its backlog.
   */
  if (organization.status !== 'active') {
    return NextResponse.json(
      { error: `Organization "${slug}" is not active; nothing was ingested.` },
      { status: 409 },
    )
  }

  try {
    const result = await ingestMessages(
      supabase,
      organization.id as string,
      messages as IncomingMessage[],
    )
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Ingestion failed' },
      { status: 500 },
    )
  }
}
