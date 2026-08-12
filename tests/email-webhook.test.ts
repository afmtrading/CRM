import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { verifyResendWebhook } from '../src/lib/email/webhook'

const SECRET = `whsec_${Buffer.from('a-signing-secret-of-some-length').toString('base64')}`

function sign(body: string, options: { id?: string; timestamp?: number; secret?: string } = {}) {
  const id = options.id ?? 'msg_123'
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000))
  const key = Buffer.from((options.secret ?? SECRET).replace(/^whsec_/, ''), 'base64')
  const digest = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')

  return new Headers({
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${digest}`,
  })
}

const BODY = JSON.stringify({ type: 'email.bounced', data: { email_id: 'abc' } })

describe('verifyResendWebhook', () => {
  it('accepts a message the provider signed', () => {
    expect(verifyResendWebhook(sign(BODY), BODY, SECRET)).toEqual({ ok: true })
  })

  it('refuses a message with no signature at all', () => {
    // The whole point: without this check, anybody who knows the URL can mark
    // any address as bounced — and a bounce writes a suppression.
    const result = verifyResendWebhook(new Headers(), BODY, SECRET)
    expect(result.ok).toBe(false)
  })

  it('refuses a signature made with a different secret', () => {
    const headers = sign(BODY, { secret: `whsec_${Buffer.from('wrong-secret').toString('base64')}` })
    expect(verifyResendWebhook(headers, BODY, SECRET).ok).toBe(false)
  })

  it('refuses a body that changed after it was signed', () => {
    const headers = sign(BODY)
    const tampered = JSON.stringify({ type: 'email.bounced', data: { email_id: 'someone-else' } })
    expect(verifyResendWebhook(headers, tampered, SECRET).ok).toBe(false)
  })

  it('refuses a replay from an hour ago', () => {
    // A signature stays valid forever; the timestamp is what expires it.
    const headers = sign(BODY, { timestamp: Math.floor(Date.now() / 1000) - 3600 })
    expect(verifyResendWebhook(headers, BODY, SECRET).ok).toBe(false)
  })

  it('refuses a timestamp from the future too', () => {
    const headers = sign(BODY, { timestamp: Math.floor(Date.now() / 1000) + 3600 })
    expect(verifyResendWebhook(headers, BODY, SECRET).ok).toBe(false)
  })

  it('refuses a signature that is the right length but wrong', () => {
    const headers = sign(BODY)
    const wrong = Buffer.alloc(32, 1).toString('base64')
    headers.set('svix-signature', `v1,${wrong}`)
    expect(verifyResendWebhook(headers, BODY, SECRET).ok).toBe(false)
  })

  it('survives a malformed signature rather than throwing', () => {
    // timingSafeEqual raises on a length mismatch, and this input comes from a
    // stranger — a crash here would be a denial of service.
    const headers = sign(BODY)
    headers.set('svix-signature', 'v1,not-base64-at-all')
    expect(() => verifyResendWebhook(headers, BODY, SECRET)).not.toThrow()
    expect(verifyResendWebhook(headers, BODY, SECRET).ok).toBe(false)
  })

  it('accepts when one of several offered signatures matches', () => {
    // A secret being rotated is signed with both the old key and the new one.
    const headers = sign(BODY)
    const real = headers.get('svix-signature')
    headers.set('svix-signature', `v1,${Buffer.alloc(32, 9).toString('base64')} ${real}`)
    expect(verifyResendWebhook(headers, BODY, SECRET).ok).toBe(true)
  })

  it('ignores a version it does not know', () => {
    const headers = sign(BODY)
    const real = headers.get('svix-signature')?.replace('v1,', '')
    headers.set('svix-signature', `v2,${real}`)
    expect(verifyResendWebhook(headers, BODY, SECRET).ok).toBe(false)
  })
})
