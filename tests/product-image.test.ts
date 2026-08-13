import { describe, expect, it } from 'vitest'

import {
  MAX_IMAGE_BYTES,
  describeImageProblem,
  keyBelongsTo,
  productImageKey,
  productImageUrl,
} from '../src/lib/product-image'

/*
 * These rules run in three places — the browser before an upload starts, the
 * server before one is accepted, and the bucket itself. This is the one file
 * the first two read from, so they cannot drift into disagreeing.
 */

describe('describeImageProblem', () => {
  it('is content with the formats a catalogue can show', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']) {
      expect(describeImageProblem({ type, size: 1000 })).toBeNull()
    }
  })

  it('refuses what is not an image', () => {
    // The type is checked rather than the extension, so a PDF named .jpg is
    // caught here rather than by the bucket after the upload was paid for.
    expect(describeImageProblem({ type: 'application/pdf', size: 1000 })).toContain('not an image')
  })

  it('refuses one that is too large, and says how large it was', () => {
    const problem = describeImageProblem({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 })
    expect(problem).toContain('MB')
    expect(problem).toContain('limit')
  })

  it('accepts one exactly at the limit', () => {
    expect(describeImageProblem({ type: 'image/png', size: MAX_IMAGE_BYTES })).toBeNull()
  })

  it('refuses an empty file', () => {
    // Which is what an untouched file input posts in some browsers, and would
    // leave a product showing a broken picture.
    expect(describeImageProblem({ type: 'image/png', size: 0 })).toContain('empty')
  })
})

describe('productImageKey', () => {
  it('puts the organization first, because the storage policy reads that segment', () => {
    const key = productImageKey('org-1', 'prod-2', 'image/jpeg', 'abc')
    expect(key.split('/')[0]).toBe('org-1')
    expect(key).toBe('org-1/prod-2/abc.jpg')
  })

  it('gives each format its own extension', () => {
    expect(productImageKey('o', 'p', 'image/webp', 'r')).toContain('.webp')
    expect(productImageKey('o', 'p', 'image/avif', 'r')).toContain('.avif')
  })

  it('does not pretend to know a type it was not given', () => {
    expect(productImageKey('o', 'p', 'application/octet-stream', 'r')).toContain('.bin')
  })

  it('is different every time, so a replacement can land before the old one goes', () => {
    expect(productImageKey('o', 'p', 'image/png', 'one')).not.toBe(
      productImageKey('o', 'p', 'image/png', 'two'),
    )
  })
})

describe('productImageUrl', () => {
  it('builds the public URL from the key', () => {
    expect(productImageUrl('org/prod/x.jpg', 'https://abc.supabase.co')).toBe(
      'https://abc.supabase.co/storage/v1/object/public/product-images/org/prod/x.jpg',
    )
  })

  it('does not double the slash when the host carries one', () => {
    expect(productImageUrl('a.png', 'https://abc.supabase.co/')).toBe(
      'https://abc.supabase.co/storage/v1/object/public/product-images/a.png',
    )
  })

  it('has nothing to build without a key', () => {
    expect(productImageUrl(null, 'https://abc.supabase.co')).toBeNull()
    expect(productImageUrl('', 'https://abc.supabase.co')).toBeNull()
  })

  it('has nothing to build without a host either', () => {
    // Rather than returning a relative URL that would 404 quietly.
    expect(productImageUrl('a.png', undefined)).toBeNull()
  })
})

describe('keyBelongsTo', () => {
  it('reads the owner off the front of the key', () => {
    expect(keyBelongsTo('org-1/prod/x.jpg', 'org-1')).toBe(true)
    expect(keyBelongsTo('org-2/prod/x.jpg', 'org-1')).toBe(false)
  })

  it('is not fooled by the id appearing later in the path', () => {
    // The app deletes the object a product used to point at, so a tampered
    // field must not talk it into deleting somebody else's.
    expect(keyBelongsTo('org-2/org-1/x.jpg', 'org-1')).toBe(false)
  })

  it('owns nothing when there is no key', () => {
    expect(keyBelongsTo(null, 'org-1')).toBe(false)
  })
})
