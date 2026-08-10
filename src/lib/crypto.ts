import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Authenticated encryption for the one secret this app stores on someone
 * else's behalf: a Gmail refresh token.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt rather than
 * decrypting to something attacker-chosen. The envelope is
 *
 *   v1.<iv>.<auth tag>.<ciphertext>
 *
 * with each part base64url. The version prefix exists so a future key rotation
 * or algorithm change can be told apart from a corrupt value instead of
 * guessed at.
 *
 * The key lives in MAILBOX_TOKEN_KEY, outside the database. That is the point:
 * a leaked database backup is then a pile of ciphertext rather than a set of
 * keys to everybody's mailbox.
 */

const VERSION = 'v1'
const IV_BYTES = 12 // 96 bits, the size GCM is defined for
const KEY_BYTES = 32

export class CryptoConfigError extends Error {}

/** Decodes and checks the configured key. Throws with a usable message. */
export function tokenKey(): Buffer {
  const raw = process.env.MAILBOX_TOKEN_KEY

  if (!raw) {
    throw new CryptoConfigError(
      'MAILBOX_TOKEN_KEY is not set. Generate one with: openssl rand -base64 32',
    )
  }

  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new CryptoConfigError(
      `MAILBOX_TOKEN_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}. Generate one with: openssl rand -base64 32`,
    )
  }

  return key
}

export function isTokenKeyConfigured(): boolean {
  try {
    tokenKey()
    return true
  } catch {
    return false
  }
}

/** Encrypts a secret. A fresh IV per call, so the same input never repeats. */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

/** Reverses seal(). Throws if the envelope was tampered with or truncated. */
export function open(envelope: string, key: Buffer): string {
  const parts = envelope.split('.')
  if (parts.length !== 4) throw new Error('Malformed encrypted value')

  const [version, iv, tag, ciphertext] = parts
  if (version !== VERSION) throw new Error(`Unsupported encrypted value version "${version}"`)

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))

  // GCM raises on a bad tag, which is exactly the behaviour wanted: a token
  // that has been altered must not come back as a usable string.
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

export function sealToken(plaintext: string): string {
  return seal(plaintext, tokenKey())
}

export function openToken(envelope: string): string {
  return open(envelope, tokenKey())
}

/** Constant-time string comparison, for the OAuth state nonce. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
