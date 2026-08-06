import { NextResponse } from 'next/server'
import { z } from 'zod'

import { createSupabaseAdminClient } from '@/lib/supabase/server'
import {
  activityTypeFor,
  counterpartyAddresses,
  timelineSubject,
  type IncomingMessage,
} from '@/lib/sync'

/**
 * POST /activities/ingest — the CRM side of the Gmail and Calendar sync (6.4).
 *
 * A connector process polls the mailbox and posts what it finds here. Messages
 * involving a known contact's email address land on that contact's timeline
 * without anyone logging them by hand, which is the acceptance criterion.
 *
 * Security notes, because this route deliberately runs outside a user session:
 *  - It authenticates with a shared secret, not a user JWT, since a background
 *    job has no session.
 *  - It therefore uses the service-role client, which bypasses RLS. The
 *    organization is taken from the request and every lookup and write is
 *    filtered to it explicitly — this route is the one place in the codebase
 *    where the application filter is the *only* tenant boundary, so it is kept
 *    small and obvious.
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
    .select('id')
    .eq('slug', slug)
    .maybeSingle()

  if (!organization) {
    return NextResponse.json({ error: `Unknown organization "${slug}"` }, { status: 404 })
  }

  const organizationId = organization.id as string

  // The mailbox owner, so the activity is attributed to the right user.
  const mailboxes = [...new Set(messages.map((message) => message.mailboxAddress.toLowerCase()))]
  const { data: owners } = await supabase
    .from('users')
    .select('id, email')
    .eq('organization_id', organizationId)
    .in('email', mailboxes)

  const ownerByEmail = new Map(
    ((owners ?? []) as { id: string; email: string }[]).map((user) => [
      user.email.toLowerCase(),
      user.id,
    ]),
  )

  // Resolve every counterparty address in one query, scoped to this organization.
  const addresses = [...new Set(messages.flatMap((message) => counterpartyAddresses(message as IncomingMessage)))]

  const { data: contacts } = addresses.length
    ? await supabase
        .from('contacts')
        .select('id, email')
        .eq('organization_id', organizationId)
        .is('duplicate_of_id', null)
        .in('email', addresses)
    : { data: [] }

  const contactByEmail = new Map(
    ((contacts ?? []) as { id: string; email: string | null }[])
      .filter((contact) => contact.email)
      .map((contact) => [contact.email!.toLowerCase(), contact.id]),
  )

  const rows: Record<string, unknown>[] = []
  let unmatched = 0

  for (const message of messages) {
    const matches = counterpartyAddresses(message as IncomingMessage)
      .map((address) => contactByEmail.get(address))
      .filter((id): id is string => Boolean(id))

    if (matches.length === 0) {
      // Nobody in the CRM was involved — nothing to log against.
      unmatched += 1
      continue
    }

    // A message can involve several known contacts; each gets its own timeline
    // entry, with the contact id folded into external_id so they stay distinct
    // and each remains individually idempotent.
    for (const contactId of [...new Set(matches)]) {
      rows.push({
        organization_id: organizationId,
        type: activityTypeFor(message as IncomingMessage),
        related_to_type: 'contact',
        related_to_id: contactId,
        owner_id: ownerByEmail.get(message.mailboxAddress.toLowerCase()) ?? null,
        subject: timelineSubject(message as IncomingMessage),
        body: message.body ?? null,
        external_source: message.source,
        external_id: `${message.externalId}:${contactId}`,
        occurred_at: message.occurredAt,
      })
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ logged: 0, unmatched })
  }

  const { data: inserted, error } = await supabase
    .from('activities')
    .upsert(rows, { onConflict: 'organization_id,external_source,external_id', ignoreDuplicates: true })
    .select('id')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    logged: inserted?.length ?? 0,
    duplicates: rows.length - (inserted?.length ?? 0),
    unmatched,
  })
}
