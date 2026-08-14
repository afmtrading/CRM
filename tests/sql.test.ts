import { describe, expect, it } from 'vitest'

import { likeContains, likeLiteral } from '../src/lib/sql'

describe('escaping a LIKE pattern', () => {
  it('leaves ordinary text alone', () => {
    expect(likeLiteral('Acme Trading')).toBe('Acme Trading')
    expect(likeLiteral('')).toBe('')
  })

  /*
   * The one that mattered. Underscores are ordinary in email addresses, and the
   * importer used ilike as its duplicate check — so importing john_doe@acme.com
   * could match johnXdoe@acme.com and merge a CSV row into the wrong person.
   */
  it('escapes the underscore, which matches any single character', () => {
    expect(likeLiteral('john_doe@acme.com')).toBe('john\\_doe@acme.com')
  })

  it('escapes the percent, which matches anything at all', () => {
    expect(likeLiteral('50% Off Ltd')).toBe('50\\% Off Ltd')
  })

  // Backslash first, or it escapes the escapes added after it.
  it('escapes the escape character itself', () => {
    expect(likeLiteral('a\\b')).toBe('a\\\\b')
    expect(likeLiteral('a\\_b')).toBe('a\\\\\\_b')
  })

  it('escapes every occurrence, not just the first', () => {
    expect(likeLiteral('a_b_c')).toBe('a\\_b\\_c')
    expect(likeLiteral('%%')).toBe('\\%\\%')
  })
})

describe('a search box pattern', () => {
  it('wraps the value in the app’s own wildcards', () => {
    expect(likeContains('acme')).toBe('%acme%')
  })

  // The wildcards belong to the app; what the person typed is text.
  it('does not let the typed value bring its own', () => {
    expect(likeContains('50%')).toBe('%50\\%%')
    expect(likeContains('a_b')).toBe('%a\\_b%')
  })

  it('still matches everything when nothing was typed', () => {
    expect(likeContains('')).toBe('%%')
  })
})
