import { describe, expect, it } from 'vitest'

import {
  activityTypeFor,
  counterpartyAddresses,
  extractAddress,
  messageDirection,
  timelineSubject,
  type IncomingMessage,
} from '@/lib/sync'

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    source: 'gmail',
    externalId: 'msg-1',
    type: 'email',
    subject: 'Quarterly numbers',
    mailboxAddress: 'rep@flo.com',
    from: 'rep@flo.com',
    to: ['buyer@acme.com'],
    occurredAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  }
}

describe('extractAddress', () => {
  it('unwraps a display-name address', () => {
    expect(extractAddress('Ada Lovelace <Ada@Example.com>')).toBe('ada@example.com')
  })

  it('handles a bare address', () => {
    expect(extractAddress('  Ada@Example.com ')).toBe('ada@example.com')
  })
})

describe('counterpartyAddresses', () => {
  it('excludes the mailbox owner', () => {
    expect(counterpartyAddresses(message())).toEqual(['buyer@acme.com'])
  })

  it('collects senders, recipients, cc and attendees', () => {
    const addresses = counterpartyAddresses(
      message({
        from: 'Buyer <buyer@acme.com>',
        to: ['rep@flo.com', 'assistant@acme.com'],
        cc: ['legal@acme.com'],
        attendees: ['legal@acme.com', 'cfo@acme.com'],
      }),
    )

    expect(addresses).toEqual(['buyer@acme.com', 'assistant@acme.com', 'legal@acme.com', 'cfo@acme.com'])
  })

  it('de-duplicates an address that appears in several fields', () => {
    const addresses = counterpartyAddresses(
      message({ to: ['buyer@acme.com'], cc: ['BUYER@acme.com'] }),
    )
    expect(addresses).toEqual(['buyer@acme.com'])
  })

  it('returns nothing for a note-to-self', () => {
    expect(counterpartyAddresses(message({ to: ['rep@flo.com'] }))).toEqual([])
  })
})

describe('timeline rendering', () => {
  it('labels an email the rep sent', () => {
    expect(messageDirection(message())).toBe('outbound')
    expect(timelineSubject(message())).toBe('Sent: Quarterly numbers')
  })

  it('labels an email the rep received', () => {
    const received = message({ from: 'buyer@acme.com', to: ['rep@flo.com'] })
    expect(messageDirection(received)).toBe('inbound')
    expect(timelineSubject(received)).toBe('Received: Quarterly numbers')
  })

  it('leaves meetings undirected', () => {
    const meeting = message({ type: 'meeting', subject: 'Kickoff', from: null })
    expect(messageDirection(meeting)).toBeNull()
    expect(timelineSubject(meeting)).toBe('Kickoff')
    expect(activityTypeFor(meeting)).toBe('meeting')
  })

  it('falls back to a sensible subject when there is none', () => {
    expect(timelineSubject(message({ subject: '' }))).toBe('Sent: Email')
    expect(timelineSubject(message({ type: 'meeting', subject: '', from: null }))).toBe('Meeting')
  })
})
