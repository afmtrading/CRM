import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HistoryExpiredError,
  backfillQuery,
  buildAuthUrl,
  decodeBase64Url,
  extractPlainTextBody,
  headerValue,
  htmlToText,
  listHistory,
  parseGmailMessage,
  splitAddressList,
  stripQuotedReply,
  type GmailMessage,
} from '../src/lib/gmail'
import { counterpartyAddresses } from '../src/lib/sync'

const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url')

describe('splitAddressList', () => {
  it('splits a plain list', () => {
    expect(splitAddressList('a@x.com, b@y.com')).toEqual(['a@x.com', 'b@y.com'])
  })

  it('keeps a quoted display name containing a comma together', () => {
    expect(splitAddressList('"Doe, John" <j@x.com>, a@y.com')).toEqual([
      '"Doe, John" <j@x.com>',
      'a@y.com',
    ])
  })

  it('ignores commas inside angle brackets', () => {
    expect(splitAddressList('Buyer <buyer@acme.com>, Rep <rep@flo.com>')).toEqual([
      'Buyer <buyer@acme.com>',
      'Rep <rep@flo.com>',
    ])
  })

  it('returns nothing for an absent header', () => {
    expect(splitAddressList(null)).toEqual([])
    expect(splitAddressList('')).toEqual([])
  })
})

describe('extractPlainTextBody', () => {
  it('reads a simple body', () => {
    expect(
      extractPlainTextBody({ mimeType: 'text/plain', body: { data: encode('Hello') } }),
    ).toBe('Hello')
  })

  it('prefers plain text over HTML in a multipart alternative', () => {
    const body = extractPlainTextBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: encode('<p>HTML</p>') } },
        { mimeType: 'text/plain', body: { data: encode('Plain') } },
      ],
    })
    expect(body).toBe('Plain')
  })

  it('digs through nested multipart wrappers', () => {
    const body = extractPlainTextBody({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/plain', body: { data: encode('Buried') } }],
        },
        { mimeType: 'application/pdf', body: { size: 1024 } },
      ],
    })
    expect(body).toBe('Buried')
  })

  it('falls back to HTML when that is all there is', () => {
    const body = extractPlainTextBody({
      mimeType: 'text/html',
      body: { data: encode('<p>Only HTML</p>') },
    })
    expect(body).toBe('Only HTML')
  })

  it('returns empty for a message with no body at all', () => {
    expect(extractPlainTextBody(undefined)).toBe('')
    expect(extractPlainTextBody({ mimeType: 'multipart/mixed', parts: [] })).toBe('')
  })
})

describe('htmlToText', () => {
  it('drops style and script blocks entirely', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Hi</p>')).toBe('Hi')
  })

  it('turns block ends into line breaks', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\nTwo')
  })

  it('unescapes entities', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &lt;3</p>')).toBe('Tom & Jerry <3')
  })
})

describe('stripQuotedReply', () => {
  it('cuts the quoted chain at the On … wrote: line', () => {
    const text = 'Yes, that works.\n\nOn Mon, 3 Aug 2026 at 10:04, Buyer wrote:\n> Original question'
    expect(stripQuotedReply(text)).toBe('Yes, that works.')
  })

  it('cuts at an Outlook original-message divider', () => {
    const text = 'Confirmed.\n\n-----Original Message-----\nFrom: someone'
    expect(stripQuotedReply(text)).toBe('Confirmed.')
  })

  it('drops stray quoted lines above the cut', () => {
    expect(stripQuotedReply('Agreed.\n> old line\nThanks.')).toBe('Agreed.\nThanks.')
  })

  it('keeps the original when a reply is nothing but a quote', () => {
    const text = '> everything was quoted'
    expect(stripQuotedReply(text)).toBe(text)
  })

  it('leaves an ordinary message alone', () => {
    expect(stripQuotedReply('Just a note.')).toBe('Just a note.')
  })
})

describe('parseGmailMessage', () => {
  const message: GmailMessage = {
    id: '18f2c9a4b7e1',
    labelIds: ['INBOX'],
    internalDate: '1785000000000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Re: Q3 shipment' },
        { name: 'From', value: 'Buyer <buyer@acme.com>' },
        { name: 'To', value: 'Rep <rep@flo.com>' },
        { name: 'Cc', value: '"Ops, Team" <ops@acme.com>' },
      ],
      body: { data: encode('Confirming.\n\nOn Mon, Buyer wrote:\n> earlier') },
    },
  }

  it('maps a message into the shape the ingest side already understands', () => {
    const parsed = parseGmailMessage(message, 'rep@flo.com')!

    expect(parsed.source).toBe('gmail')
    expect(parsed.externalId).toBe('18f2c9a4b7e1')
    expect(parsed.type).toBe('email')
    expect(parsed.subject).toBe('Re: Q3 shipment')
    expect(parsed.body).toBe('Confirming.')
    expect(parsed.from).toBe('Buyer <buyer@acme.com>')
    expect(parsed.cc).toEqual(['"Ops, Team" <ops@acme.com>'])
  })

  it('dates the entry from Gmail rather than the sender-controlled header', () => {
    const parsed = parseGmailMessage(message, 'rep@flo.com')!
    expect(parsed.occurredAt).toBe(new Date(1785000000000).toISOString())
  })

  it('yields exactly the counterparties, never the mailbox owner', () => {
    const parsed = parseGmailMessage(message, 'rep@flo.com')!
    expect(counterpartyAddresses(parsed).sort()).toEqual(['buyer@acme.com', 'ops@acme.com'])
  })

  it('ignores drafts, spam and binned mail', () => {
    for (const label of ['DRAFT', 'SPAM', 'TRASH', 'CHAT']) {
      expect(parseGmailMessage({ ...message, labelIds: [label] }, 'rep@flo.com')).toBeNull()
    }
  })

  it('falls back to the snippet when a message has no readable body', () => {
    const parsed = parseGmailMessage(
      { ...message, payload: { ...message.payload, body: undefined }, snippet: 'A snippet' },
      'rep@flo.com',
    )!
    expect(parsed.body).toBe('A snippet')
  })

  it('survives a message with no headers', () => {
    const parsed = parseGmailMessage({ id: 'x', labelIds: ['INBOX'] }, 'rep@flo.com')!
    expect(parsed.subject).toBe('')
    expect(parsed.to).toEqual([])
  })
})

describe('headerValue', () => {
  it('matches case-insensitively, because header casing varies', () => {
    const payload = { headers: [{ name: 'subject', value: 'Hello' }] }
    expect(headerValue(payload, 'Subject')).toBe('Hello')
  })
})

describe('backfillQuery', () => {
  it('asks for whole seconds, which is all Gmail accepts', () => {
    const now = new Date('2026-08-09T00:00:00.000Z')
    const expected = Math.floor((now.getTime() - 30 * 86_400_000) / 1000)

    expect(backfillQuery(30, now)).toBe(`after:${expected} -in:chats`)
    expect(String(expected)).not.toContain('.')
  })

  it('excludes chats from the backfill', () => {
    expect(backfillQuery(7)).toContain('-in:chats')
  })
})

describe('buildAuthUrl', () => {
  const url = new URL(
    buildAuthUrl({
      clientId: 'client-123',
      redirectUri: 'https://crm.example.com/api/gmail/callback',
      state: 'nonce',
    }),
  )

  it('asks for offline access and forces consent, so a refresh token always comes back', () => {
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })

  it('requests read-only scope and nothing that could send or delete mail', () => {
    const scopes = url.searchParams.get('scope') ?? ''
    expect(scopes).toContain('gmail.readonly')
    expect(scopes).not.toContain('gmail.send')
    expect(scopes).not.toContain('gmail.modify')
    expect(scopes).not.toContain('https://mail.google.com/')
  })

  it('carries the state nonce', () => {
    expect(url.searchParams.get('state')).toBe('nonce')
  })
})

describe('decodeBase64Url', () => {
  it('decodes the URL-safe alphabet Gmail uses', () => {
    expect(decodeBase64Url(encode('a?b=c&d'))).toBe('a?b=c&d')
  })
})

describe('listHistory', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** One history record carrying `count` added messages, numbered from `from`. */
  const record = (id: number, from: number, count: number) => ({
    id,
    messagesAdded: Array.from({ length: count }, (_, i) => ({ message: { id: `m${from + i}` } })),
  })

  /** Serves the given pages in order, so pagination can be driven without a network. */
  const serve = (pages: Record<string, unknown>[], status = 200) => {
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      const body = pages[Math.min(call, pages.length - 1)]
      call += 1
      return { status, json: async () => body } as unknown as Response
    }) as typeof fetch
    return () => call
  }

  it('returns every message and the mailbox cursor when nothing is truncated', async () => {
    serve([{ history: [record(11, 1, 2), record(12, 3, 1)], historyId: '99' }])

    const window = await listHistory('token', '10', 75)

    expect(window.messageIds).toEqual(['m1', 'm2', 'm3'])
    expect(window.historyId).toBe('99')
    expect(window.truncated).toBe(false)
  })

  it('follows pagination', async () => {
    serve([
      { history: [record(11, 1, 1)], nextPageToken: 'p2' },
      { history: [record(12, 2, 1)], historyId: '99' },
    ])

    const window = await listHistory('token', '10', 75)

    expect(window.messageIds).toEqual(['m1', 'm2'])
    expect(window.historyId).toBe('99')
  })

  /*
   * The regression this whole change exists for. The caller stores the cursor
   * after ingesting what it was handed, so a cursor past unreturned messages
   * loses them permanently and silently.
   */
  it('stops short rather than advancing the cursor past messages it did not return', async () => {
    serve([{ history: [record(11, 1, 2), record(12, 3, 2)], historyId: '99' }])

    const window = await listHistory('token', '10', 3)

    expect(window.messageIds).toEqual(['m1', 'm2'])
    expect(window.truncated).toBe(true)
    // The last record wholly read — not the mailbox's current position.
    expect(window.historyId).toBe('11')
    expect(window.historyId).not.toBe('99')
  })

  it('resumes from the truncation point, losing nothing across two runs', async () => {
    serve([{ history: [record(11, 1, 2), record(12, 3, 2)], historyId: '99' }])
    const first = await listHistory('token', '10', 3)

    // Second run, starting where the first stopped: Gmail returns the rest.
    serve([{ history: [record(12, 3, 2)], historyId: '99' }])
    const second = await listHistory('token', first.historyId!, 3)

    expect([...first.messageIds, ...second.messageIds]).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(second.truncated).toBe(false)
    expect(second.historyId).toBe('99')
  })

  it('takes a single oversized record whole, so a mailbox cannot stall on it', async () => {
    serve([{ history: [record(11, 1, 5)], historyId: '99' }])

    const window = await listHistory('token', '10', 2)

    // Progress beats the ceiling: half a record is not a cursor position.
    expect(window.messageIds).toHaveLength(5)
    expect(window.truncated).toBe(false)
  })

  it('does not double-count a message reported in two records', async () => {
    serve([{ history: [record(11, 1, 1), record(12, 1, 1)], historyId: '99' }])

    const window = await listHistory('token', '10', 75)

    expect(window.messageIds).toEqual(['m1'])
  })

  it('treats an expired cursor as its own kind of failure', async () => {
    serve([{}], 404)

    await expect(listHistory('token', '10', 75)).rejects.toBeInstanceOf(HistoryExpiredError)
  })
})
