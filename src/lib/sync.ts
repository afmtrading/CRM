/**
 * Mailbox and calendar sync (PRD 6.4).
 *
 * The CRM side of the sync: given a message or event that a connector has
 * fetched from Gmail/Google Calendar, work out which contact it belongs to and
 * what the timeline entry should say. Pure functions, so the matching rules are
 * testable without a mailbox.
 *
 * The connector itself (OAuth, polling, push notifications) is a separate
 * process that calls POST /api/activities/ingest — see docs/SYNC.md.
 */

import type { ActivityType } from '@/lib/database.types'

export interface IncomingMessage {
  /** 'gmail' | 'google_calendar' | anything a future connector reports as. */
  source: string
  /** Provider-side id. Re-delivering the same id must not duplicate the entry. */
  externalId: string
  type: 'email' | 'meeting'
  subject: string
  body?: string | null
  /** The mailbox owner's own address, so their own participation is excluded. */
  mailboxAddress: string
  from?: string | null
  to?: string[]
  cc?: string[]
  attendees?: string[]
  occurredAt: string
}

/** Pulls a bare address out of "Name <addr@example.com>" style values. */
export function extractAddress(value: string): string {
  const angled = value.match(/<([^>]+)>/)
  const raw = (angled ? angled[1] : value).trim().toLowerCase()
  return raw
}

/**
 * Every address involved in a message except the mailbox owner's own.
 *
 * Those are the addresses worth matching against contacts: an email the owner
 * sent to themselves is not a customer interaction.
 */
export function counterpartyAddresses(message: IncomingMessage): string[] {
  const mailbox = extractAddress(message.mailboxAddress)

  const all = [
    message.from ? [message.from] : [],
    message.to ?? [],
    message.cc ?? [],
    message.attendees ?? [],
  ]
    .flat()
    .map(extractAddress)
    .filter((address) => address.length > 0 && address !== mailbox)

  return [...new Set(all)]
}

export function activityTypeFor(message: IncomingMessage): ActivityType {
  return message.type === 'meeting' ? 'meeting' : 'email'
}

/**
 * The direction of an email, used to make the timeline read naturally.
 * Calendar events have no direction.
 */
export function messageDirection(message: IncomingMessage): 'inbound' | 'outbound' | null {
  if (message.type !== 'email') return null
  if (!message.from) return null
  return extractAddress(message.from) === extractAddress(message.mailboxAddress)
    ? 'outbound'
    : 'inbound'
}

export function timelineSubject(message: IncomingMessage): string {
  const subject = message.subject?.trim() || (message.type === 'meeting' ? 'Meeting' : 'Email')
  const direction = messageDirection(message)

  if (direction === 'outbound') return `Sent: ${subject}`
  if (direction === 'inbound') return `Received: ${subject}`
  return subject
}
