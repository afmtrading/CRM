import 'server-only'

import {
  activityTypeFor,
  counterpartyAddresses,
  timelineSubject,
  type IncomingMessage,
} from '@/lib/sync'
import type { AppSupabaseClient } from '@/lib/supabase/server'

/**
 * Turning fetched messages into timeline entries.
 *
 * Extracted from the ingest route so the built-in Gmail poller can call it
 * directly instead of posting to the app over HTTP — one code path, one set of
 * rules, whether the messages arrive from the poller or from an external
 * connector.
 *
 * The client passed in is the service-role one, which bypasses RLS. That makes
 * `organizationId` the only tenant boundary here, so every lookup and every
 * written row is filtered to it explicitly. This is the one place in the
 * codebase where that is true, which is why it is small and stays small.
 */

export type IngestResult = { logged: number; duplicates: number; unmatched: number }

export async function ingestMessages(
  supabase: AppSupabaseClient,
  organizationId: string,
  messages: IncomingMessage[],
): Promise<IngestResult> {
  if (messages.length === 0) return { logged: 0, duplicates: 0, unmatched: 0 }

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
  const addresses = [...new Set(messages.flatMap((message) => counterpartyAddresses(message)))]

  const { data: contacts } = addresses.length
    ? await supabase
        .from('contacts')
        .select('id, email')
        .eq('organization_id', organizationId)
        .is('duplicate_of_id', null)
        // A deleted contact is in the recycle bin; new mail should not quietly
        // reappear on a record nobody but an admin can see.
        .is('deleted_at', null)
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
    const matches = counterpartyAddresses(message)
      .map((address) => contactByEmail.get(address))
      .filter((id): id is string => Boolean(id))

    if (matches.length === 0) {
      // Nobody in the CRM was involved — nothing to log against. Personal mail
      // is dropped here rather than stored and filtered later.
      unmatched += 1
      continue
    }

    // A message can involve several known contacts; each gets its own timeline
    // entry, with the contact id folded into external_id so they stay distinct
    // and each remains individually idempotent.
    for (const contactId of [...new Set(matches)]) {
      rows.push({
        organization_id: organizationId,
        type: activityTypeFor(message),
        related_to_type: 'contact',
        related_to_id: contactId,
        owner_id: ownerByEmail.get(message.mailboxAddress.toLowerCase()) ?? null,
        subject: timelineSubject(message),
        body: message.body ?? null,
        external_source: message.source,
        external_id: `${message.externalId}:${contactId}`,
        occurred_at: message.occurredAt,
      })
    }
  }

  if (rows.length === 0) return { logged: 0, duplicates: 0, unmatched }

  const { data: inserted, error } = await supabase
    .from('activities')
    .upsert(rows, {
      onConflict: 'organization_id,external_source,external_id',
      ignoreDuplicates: true,
    })
    .select('id')

  if (error) throw new Error(error.message)

  const logged = inserted?.length ?? 0
  return { logged, duplicates: rows.length - logged, unmatched }
}
