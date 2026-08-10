/**
 * Google Calendar, the second half of PRD 6.4.
 *
 * Deliberately shaped like `src/lib/gmail.ts`: it knows about Google and
 * produces the provider-neutral `IncomingMessage`, and `src/lib/ingest.ts`
 * decides what that means for the CRM. The matching and idempotency rules are
 * not re-implemented here — a meeting travels the same path an email does.
 *
 * Reads only. The scope cannot create, move or cancel anything in a calendar.
 */

import { GmailAuthError } from '@/lib/gmail'
import type { IncomingMessage } from '@/lib/sync'

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

/**
 * Google has stopped honouring a sync token — usually because it aged out, or
 * the calendar changed in a way that invalidates incremental reads. Its own
 * kind, because the answer is a bounded full read rather than a retry.
 */
export class SyncTokenExpiredError extends Error {}

/**
 * The calendar scope was never granted. Distinct from a dead token: the Gmail
 * half of the same connection is still perfectly good, so this must not take
 * the whole mailbox down.
 */
export class CalendarNotAuthorisedError extends Error {}

export type CalendarEvent = {
  id?: string
  status?: string
  summary?: string
  description?: string
  start?: { dateTime?: string; date?: string }
  organizer?: { email?: string; self?: boolean }
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[]
}

/** Bodies are capped for the same reason email bodies are: a timeline entry. */
const MAX_BODY = 20_000

/**
 * An event as the CRM would record it, or null if it is not worth recording.
 *
 * Dropped here rather than after matching: a cancelled event, or one the owner
 * declined, did not happen, and a solo block in somebody's calendar is not a
 * customer interaction whatever else it is.
 */
export function parseCalendarEvent(
  event: CalendarEvent,
  mailboxAddress: string,
): IncomingMessage | null {
  if (!event.id) return null
  if (event.status === 'cancelled') return null

  const self = event.attendees?.find((attendee) => attendee.self)
  if (self?.responseStatus === 'declined') return null

  const attendees = [
    ...(event.attendees ?? []).map((attendee) => attendee.email),
    event.organizer?.email,
  ].filter((email): email is string => Boolean(email))

  // Nobody but the owner: a focus block, a reminder, a personal appointment.
  if (attendees.length === 0) return null

  const startedAt = event.start?.dateTime ?? event.start?.date
  if (!startedAt) return null

  const occurredAt = new Date(startedAt)
  if (Number.isNaN(occurredAt.getTime())) return null

  return {
    source: 'google_calendar',
    externalId: event.id,
    type: 'meeting',
    subject: event.summary?.trim() || 'Meeting',
    body: event.description ? event.description.slice(0, MAX_BODY) : null,
    mailboxAddress,
    attendees,
    occurredAt: occurredAt.toISOString(),
  }
}

async function calendarFetch(
  accessToken: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${CALENDAR_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { status: response.status, body }
}

/**
 * Events since the last run, or a bounded first read.
 *
 * `singleEvents` expands a recurring event into its occurrences, so a weekly
 * call lands on the timeline as the weekly calls that actually happened rather
 * than one rule describing them. Google requires the flag to stay identical
 * across a sync-token series, so it is set here rather than by the caller.
 *
 * The token is returned only on the final page: taking one from a partial read
 * would skip everything after it.
 */
export async function listEvents(
  accessToken: string,
  options: { syncToken?: string | null; days: number; limit: number },
): Promise<{ events: CalendarEvent[]; nextSyncToken: string | null }> {
  const events: CalendarEvent[] = []
  let pageToken: string | undefined
  let nextSyncToken: string | null = null

  do {
    const query = new URLSearchParams({
      singleEvents: 'true',
      showDeleted: 'false',
      maxResults: String(Math.min(250, options.limit)),
    })

    if (options.syncToken) {
      query.set('syncToken', options.syncToken)
    } else {
      // A first read is bounded by the same window as the mailbox backfill,
      // rather than dragging in every meeting the account has ever held.
      query.set('timeMin', new Date(Date.now() - options.days * 86_400_000).toISOString())
      query.set('orderBy', 'startTime')
    }

    if (pageToken) query.set('pageToken', pageToken)

    const { status, body } = await calendarFetch(
      accessToken,
      `/calendars/primary/events?${query.toString()}`,
    )

    // 410 is Google's way of saying the incremental series is broken and the
    // caller must start again from a full read.
    if (status === 410) throw new SyncTokenExpiredError('The calendar sync token has expired')
    if (status === 401) throw new GmailAuthError('Google rejected the access token')
    // 403 here is nearly always the scope, not the account — a connection made
    // before calendar was added has a token that simply cannot read it.
    if (status === 403) {
      throw new CalendarNotAuthorisedError('This connection has no calendar permission')
    }
    if (status !== 200) throw new Error(`Calendar events request failed (${status})`)

    events.push(...((body.items ?? []) as CalendarEvent[]))

    pageToken = body.nextPageToken ? String(body.nextPageToken) : undefined
    nextSyncToken = body.nextSyncToken ? String(body.nextSyncToken) : null
  } while (pageToken && events.length < options.limit)

  return { events, nextSyncToken: pageToken ? null : nextSyncToken }
}
