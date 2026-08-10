import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { open, safeEquals, seal } from '../src/lib/crypto'

const key = randomBytes(32)

describe('seal / open', () => {
  it('round-trips a token', () => {
    const token = '1//0eXaMpLe-refresh-token_value'
    expect(open(seal(token, key), key)).toBe(token)
  })

  it('produces a different envelope every time, so equal tokens are not obvious', () => {
    expect(seal('same', key)).not.toBe(seal('same', key))
  })

  it('never contains the plaintext', () => {
    expect(seal('super-secret', key)).not.toContain('super-secret')
  })

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const envelope = seal('token', key)
    const parts = envelope.split('.')
    // Flip the ciphertext. GCM's auth tag is what makes this fail loudly.
    parts[3] = Buffer.from('tampered').toString('base64url')
    expect(() => open(parts.join('.'), key)).toThrow()
  })

  it('refuses a tampered auth tag', () => {
    const parts = seal('token', key).split('.')
    parts[2] = Buffer.from(randomBytes(16)).toString('base64url')
    expect(() => open(parts.join('.'), key)).toThrow()
  })

  it('refuses the wrong key, so a rotated key cannot silently half-work', () => {
    const envelope = seal('token', key)
    expect(() => open(envelope, randomBytes(32))).toThrow()
  })

  it('rejects a malformed envelope', () => {
    expect(() => open('not-an-envelope', key)).toThrow('Malformed encrypted value')
  })

  it('rejects an unknown version prefix', () => {
    const parts = seal('token', key).split('.')
    parts[0] = 'v2'
    expect(() => open(parts.join('.'), key)).toThrow('Unsupported')
  })

  it('handles an empty string', () => {
    expect(open(seal('', key), key)).toBe('')
  })
})

describe('safeEquals', () => {
  it('matches identical values', () => {
    expect(safeEquals('abc123', 'abc123')).toBe(true)
  })

  it('rejects different values of the same length', () => {
    expect(safeEquals('abc123', 'abc124')).toBe(false)
  })

  it('rejects different lengths without throwing', () => {
    expect(safeEquals('abc', 'abcdef')).toBe(false)
  })
})
