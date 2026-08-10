import { describe, expect, it } from 'vitest'

import { parseCalendarEvent, type CalendarEvent } from '../src/lib/calendar'
import { counterpartyAddresses } from '../src/lib/sync'

const MAILBOX = 'rep@flo.com'

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'evt_1',
  status: 'confirmed',
  summary: 'Q3 shipment review',
  description: 'Walk through the revised dates.',
  start: { dateTime: '2026-08-12T14:00:00.000Z' },
  organizer: { email: MAILBOX, self: true },
  attendees: [
    { email: MAILBOX, self: true, responseStatus: 'accepted' },
    { email: 'buyer@acme.com', responseStatus: 'accepted' },
  ],
  ...overrides,
})

describe('parseCalendarEvent', () => {
  it('maps a meeting into the shape the ingest side already understands', () => {
    const parsed = parseCalendarEvent(event(), MAILBOX)!

    expect(parsed.source).toBe('google_calendar')
    expect(parsed.externalId).toBe('evt_1')
    expect(parsed.type).toBe('meeting')
    expect(parsed.subject).toBe('Q3 shipment review')
    expect(parsed.body).toBe('Walk through the revised dates.')
    expect(parsed.occurredAt).toBe('2026-08-12T14:00:00.000Z')
  })

  it('yields the other attendees, never the mailbox owner', () => {
    const parsed = parseCalendarEvent(event(), MAILBOX)!
    expect(counterpartyAddresses(parsed)).toEqual(['buyer@acme.com'])
  })

  it('keeps an all-day event, dated from its day', () => {
    const parsed = parseCalendarEvent(
      event({ start: { date: '2026-08-12' } }),
      MAILBOX,
    )!
    expect(parsed.occurredAt).toBe('2026-08-12T00:00:00.000Z')
  })

  it('names an untitled meeting rather than logging a blank subject', () => {
    const parsed = parseCalendarEvent(event({ summary: undefined }), MAILBOX)!
    expect(parsed.subject).toBe('Meeting')
  })

  /*
   * The three kinds of thing in a calendar that are not customer interactions.
   * Matching would discard them anyway, but not before fetching and parsing.
   */
  it('ignores a cancelled event, because it did not happen', () => {
    expect(parseCalendarEvent(event({ status: 'cancelled' }), MAILBOX)).toBeNull()
  })

  it('ignores an event the owner declined', () => {
    const declined = event({
      attendees: [
        { email: MAILBOX, self: true, responseStatus: 'declined' },
        { email: 'buyer@acme.com', responseStatus: 'accepted' },
      ],
    })
    expect(parseCalendarEvent(declined, MAILBOX)).toBeNull()
  })

  it('ignores a solo block, which is somebody organising their own day', () => {
    expect(
      parseCalendarEvent(event({ attendees: undefined, organizer: undefined }), MAILBOX),
    ).toBeNull()
  })

  it('ignores an event with no start, which cannot be placed on a timeline', () => {
    expect(parseCalendarEvent(event({ start: undefined }), MAILBOX)).toBeNull()
    expect(parseCalendarEvent(event({ start: { dateTime: 'not a date' } }), MAILBOX)).toBeNull()
  })

  it('ignores an event with no id, which could not be deduplicated', () => {
    // Without a stable external id every poll would log the meeting again.
    expect(parseCalendarEvent(event({ id: undefined }), MAILBOX)).toBeNull()
  })

  it('keeps a meeting somebody else organised', () => {
    const theirs = event({
      organizer: { email: 'buyer@acme.com' },
      attendees: [
        { email: MAILBOX, self: true, responseStatus: 'accepted' },
        { email: 'buyer@acme.com', responseStatus: 'accepted' },
      ],
    })

    const parsed = parseCalendarEvent(theirs, MAILBOX)!
    expect(counterpartyAddresses(parsed)).toEqual(['buyer@acme.com'])
  })

  it('caps a long description, as the email side caps a long body', () => {
    const parsed = parseCalendarEvent(event({ description: 'x'.repeat(30_000) }), MAILBOX)!
    expect(parsed.body).toHaveLength(20_000)
  })
})
