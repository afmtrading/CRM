import { describe, expect, it } from 'vitest'

import { LOGO_TYPES, logoObjectKey, logoObjectPath } from '@/lib/logo'

const BASE = 'https://abc.supabase.co/storage/v1/object/public/org-logos/'

describe('logoObjectPath', () => {
  it('finds the key inside one of our own URLs', () => {
    expect(logoObjectPath(`${BASE}org-1/logo-1234.png`)).toBe('org-1/logo-1234.png')
  })

  it('ignores the cache-busting query a CDN may add', () => {
    expect(logoObjectPath(`${BASE}org-1/logo-1234.png?v=2`)).toBe('org-1/logo-1234.png')
    expect(logoObjectPath(`${BASE}org-1/logo-1234.png#top`)).toBe('org-1/logo-1234.png')
  })

  it('decodes a key that had to be escaped', () => {
    expect(logoObjectPath(`${BASE}org-1/my%20logo.png`)).toBe('org-1/my logo.png')
  })

  /*
   * The important half. Everything below is somebody else's file, and a wrong
   * answer here deletes it when a logo is replaced.
   */
  it('claims nothing that is not ours', () => {
    expect(logoObjectPath('https://cdn.example.com/acme/logo.png')).toBeNull()
    expect(
      logoObjectPath('https://abc.supabase.co/storage/v1/object/public/avatars/org-1/logo.png'),
    ).toBeNull()
    expect(logoObjectPath('https://abc.supabase.co/storage/v1/object/sign/org-logos/x.png')).toBeNull()
  })

  it('has nothing to say about an empty logo', () => {
    expect(logoObjectPath(null)).toBeNull()
    expect(logoObjectPath(undefined)).toBeNull()
    expect(logoObjectPath('')).toBeNull()
  })

  it('declines a URL it cannot decode rather than guessing', () => {
    expect(logoObjectPath(`${BASE}org-1/%zz.png`)).toBeNull()
  })

  it('declines a marker with nothing after it', () => {
    expect(logoObjectPath(BASE)).toBeNull()
  })
})

describe('logoObjectKey', () => {
  it('puts the file in the organization folder the policies check', () => {
    expect(logoObjectKey('org-1', 'png', 1234)).toBe('org-1/logo-1234.png')
  })

  it('never reuses a key, so no cache serves the old image', () => {
    expect(logoObjectKey('org-1', 'png', 1)).not.toBe(logoObjectKey('org-1', 'png', 2))
  })

  it('round-trips through logoObjectPath', () => {
    const key = logoObjectKey('org-1', 'jpg', 99)
    expect(logoObjectPath(`${BASE}${key}`)).toBe(key)
  })
})

describe('LOGO_TYPES', () => {
  it('accepts what the PDF renderer can embed, and nothing else', () => {
    expect(Object.keys(LOGO_TYPES).sort()).toEqual(['image/jpeg', 'image/png'])
    expect(LOGO_TYPES['image/svg+xml']).toBeUndefined()
  })
})
