/**
 * The Gmail half of the mailbox sync.
 *
 * Split into two kinds of function on purpose:
 *
 *   - Pure ones (address splitting, body extraction, quoted-reply stripping,
 *     message → IncomingMessage) that are unit tested without a mailbox.
 *   - Thin `fetch` wrappers over the Google endpoints, which are not.
 *
 * The CRM never learns anything about Gmail beyond this file: what comes out
 * the other side is the same IncomingMessage shape any connector produces, so
 * adding Outlook later means writing a second file, not touching the CRM.
 *
 * Read-only. The scopes requested here cannot send, delete or relabel mail.
 */

import type { IncomingMessage } from '@/lib/sync'

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/**
 * Deliberately minimal. `gmail.readonly` is the narrowest scope that can read
 * message bodies; `gmail.modify` and `https://mail.google.com/` would also
 * allow deleting someone's mail, which the CRM has no business doing.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
]

export class GmailAuthError extends Error {}
export class HistoryExpiredError extends Error {}

// -----------------------------------------------------------------------------
// Pure parsing
// -----------------------------------------------------------------------------

export type GmailHeader = { name: string; value: string }

export type GmailPayload = {
  mimeType?: string
  headers?: GmailHeader[]
  body?: { data?: string; size?: number }
  parts?: GmailPayload[]
}

export type GmailMessage = {
  id: string
  threadId?: string
  labelIds?: string[]
  internalDate?: string
  payload?: GmailPayload
  snippet?: string
}

export function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

export function headerValue(payload: GmailPayload | undefined, name: string): string | null {
  const match = payload?.headers?.find(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  )
  return match?.value ?? null
}

/**
 * Splits a header address list on commas, ignoring commas inside quotes or
 * angle brackets.
 *
 * `"Doe, John" <j@x.com>, a@y.com` is two addresses, not three — a plain
 * split(',') gets that wrong and produces a phantom contact match.
 */
export function splitAddressList(value: string | null | undefined): string[] {
  if (!value) return []

  const out: string[] = []
  let current = ''
  let quoted = false
  let depth = 0

  for (const char of value) {
    if (char === '"') {
      quoted = !quoted
      current += char
    } else if (char === '<' && !quoted) {
      depth += 1
      current += char
    } else if (char === '>' && !quoted) {
      depth -= 1
      current += char
    } else if (char === ',' && !quoted && depth <= 0) {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }

  out.push(current)
  return out.map((entry) => entry.trim()).filter(Boolean)
}

/**
 * The text/plain part of a message, preferring plain text over HTML.
 *
 * Multipart messages nest arbitrarily (multipart/mixed wrapping
 * multipart/alternative wrapping the parts), so this walks the tree rather
 * than assuming a shape. HTML is a last resort and is only lightly reduced to
 * text — the timeline renders markdown, not arbitrary HTML.
 */
export function extractPlainTextBody(payload: GmailPayload | undefined): string {
  if (!payload) return ''

  const plain = findPart(payload, 'text/plain')
  if (plain?.body?.data) return decodeBase64Url(plain.body.data)

  const html = findPart(payload, 'text/html')
  if (html?.body?.data) return htmlToText(decodeBase64Url(html.body.data))

  if (payload.body?.data) return decodeBase64Url(payload.body.data)
  return ''
}

function findPart(payload: GmailPayload, mimeType: string): GmailPayload | null {
  if (payload.mimeType === mimeType && payload.body?.data) return payload
  for (const part of payload.parts ?? []) {
    const found = findPart(part, mimeType)
    if (found) return found
  }
  return null
}

/** Enough to make an HTML-only email readable. Not a renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Drops the quoted chain from a reply.
 *
 * Without this every timeline entry is the whole conversation again, and the
 * fiftieth reply is fifty copies of the first. Cuts at the first quote marker
 * and keeps what the person actually wrote.
 */
export function stripQuotedReply(text: string): string {
  const markers = [
    /^On .+ wrote:\s*$/m,
    /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^_{10,}\s*$/m,
    /^From: .+$/m,
    /^Le .+ a écrit :\s*$/m,
  ]

  let cut = text.length
  for (const marker of markers) {
    const match = marker.exec(text)
    if (match?.index !== undefined && match.index < cut) cut = match.index
  }

  const kept = text
    .slice(0, cut)
    .split('\n')
    // Lines already quoted from an earlier round add nothing either.
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()

  // A reply that is nothing but a quote still deserves a timeline entry, so
  // fall back to the original rather than logging an empty body.
  return kept || text.trim()
}

const MAX_BODY = 20_000

/**
 * A Gmail message in the shape the ingest endpoint already understands.
 *
 * Returns null for anything that is not correspondence — drafts, chat, and
 * mail already in Spam or Bin. Those are not customer interactions and should
 * never reach a contact's timeline.
 */
export function parseGmailMessage(
  message: GmailMessage,
  mailboxAddress: string,
): IncomingMessage | null {
  const labels = message.labelIds ?? []
  if (labels.includes('DRAFT') || labels.includes('SPAM') || labels.includes('TRASH')) {
    return null
  }
  if (labels.includes('CHAT')) return null

  const payload = message.payload
  const body = stripQuotedReply(extractPlainTextBody(payload)).slice(0, MAX_BODY)

  // internalDate is Gmail's own receipt time in epoch milliseconds, and is
  // more reliable than the Date header, which the sender controls.
  const occurredAt = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : new Date().toISOString()

  return {
    source: 'gmail',
    externalId: message.id,
    type: 'email',
    subject: headerValue(payload, 'Subject') ?? '',
    body: body || message.snippet || null,
    mailboxAddress,
    from: headerValue(payload, 'From'),
    to: splitAddressList(headerValue(payload, 'To')),
    cc: splitAddressList(headerValue(payload, 'Cc')),
    occurredAt,
  }
}

/** `after:` takes whole seconds; Gmail rejects a millisecond timestamp. */
export function backfillQuery(days: number, now = new Date()): string {
  const since = Math.floor((now.getTime() - days * 86_400_000) / 1000)
  return `after:${since} -in:chats`
}

// -----------------------------------------------------------------------------
// Google endpoints
// -----------------------------------------------------------------------------

export function buildAuthUrl(options: {
  clientId: string
  redirectUri: string
  state: string
  loginHint?: string
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    // offline + consent together are what guarantee a refresh token. Google
    // returns one only on the first grant otherwise, so a reconnect after a
    // revocation would silently arrive without one.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: options.state,
  })

  if (options.loginHint) params.set('login_hint', options.loginHint)
  return `${OAUTH_AUTH_URL}?${params.toString()}`
}

async function tokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (!response.ok) {
    const error = String(payload.error ?? response.status)
    // invalid_grant means the grant is gone: revoked, the password changed, or
    // — on a Testing-mode consent screen — it simply passed its seven-day life.
    // Retrying will never fix any of those, so it is reported as its own kind.
    if (error === 'invalid_grant') {
      throw new GmailAuthError('Google ended the authorisation — reconnect the mailbox')
    }
    throw new Error(`Google token request failed: ${error}`)
  }

  return payload
}

export async function exchangeCode(options: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
}): Promise<{ accessToken: string; refreshToken: string | null }> {
  const payload = await tokenRequest(
    new URLSearchParams({
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      grant_type: 'authorization_code',
    }),
  )

  return {
    accessToken: String(payload.access_token ?? ''),
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
  }
}

export async function refreshAccessToken(options: {
  refreshToken: string
  clientId: string
  clientSecret: string
}): Promise<string> {
  const payload = await tokenRequest(
    new URLSearchParams({
      refresh_token: options.refreshToken,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      grant_type: 'refresh_token',
    }),
  )

  return String(payload.access_token ?? '')
}

async function gmailFetch(
  accessToken: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${GMAIL_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { status: response.status, body }
}

export async function getProfile(
  accessToken: string,
): Promise<{ emailAddress: string; historyId: string }> {
  const { status, body } = await gmailFetch(accessToken, '/profile')
  if (status !== 200) throw new Error(`Gmail profile request failed (${status})`)

  return {
    emailAddress: String(body.emailAddress ?? ''),
    historyId: String(body.historyId ?? ''),
  }
}

type HistoryEntry = { messagesAdded?: { message?: { id?: string } }[] }

/**
 * Message ids added since `startHistoryId`.
 *
 * Gmail keeps roughly a week of history and answers 404 once a cursor has aged
 * out. That is not an error to swallow — it means the incremental path is no
 * longer usable and the caller must fall back to a bounded backfill, which is
 * why it gets its own exception type.
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ messageIds: string[]; historyId: string | null }> {
  const ids = new Set<string>()
  let pageToken: string | undefined
  let historyId: string | null = null

  do {
    const query = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
    })
    if (pageToken) query.set('pageToken', pageToken)

    const { status, body } = await gmailFetch(accessToken, `/history?${query.toString()}`)

    if (status === 404) throw new HistoryExpiredError('The Gmail sync cursor has expired')
    if (status === 401 || status === 403) throw new GmailAuthError('Gmail rejected the access token')
    if (status !== 200) throw new Error(`Gmail history request failed (${status})`)

    for (const entry of (body.history ?? []) as HistoryEntry[]) {
      for (const added of entry.messagesAdded ?? []) {
        if (added.message?.id) ids.add(added.message.id)
      }
    }

    if (body.historyId) historyId = String(body.historyId)
    pageToken = body.nextPageToken ? String(body.nextPageToken) : undefined
  } while (pageToken && ids.size < 1000)

  return { messageIds: [...ids], historyId }
}

/** The backfill path: everything in the last N days, newest first. */
export async function listRecentMessageIds(
  accessToken: string,
  days: number,
  limit: number,
): Promise<string[]> {
  const query = new URLSearchParams({
    q: backfillQuery(days),
    maxResults: String(Math.min(limit, 500)),
  })

  const { status, body } = await gmailFetch(accessToken, `/messages?${query.toString()}`)

  if (status === 401 || status === 403) throw new GmailAuthError('Gmail rejected the access token')
  if (status !== 200) throw new Error(`Gmail message list failed (${status})`)

  return ((body.messages ?? []) as { id: string }[]).map((message) => message.id).slice(0, limit)
}

export async function getMessage(
  accessToken: string,
  id: string,
): Promise<GmailMessage | null> {
  const { status, body } = await gmailFetch(accessToken, `/messages/${id}?format=full`)

  if (status === 404) return null
  if (status === 401 || status === 403) throw new GmailAuthError('Gmail rejected the access token')
  if (status !== 200) throw new Error(`Gmail message fetch failed (${status})`)

  return body as unknown as GmailMessage
}
