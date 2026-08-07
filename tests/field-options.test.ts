import { describe, expect, it } from 'vitest'

import {
  daysUntilBirthday,
  prettyUrl,
  renderMarkdown,
  safeUrl,
  socialUrl,
} from '../src/lib/field-options'

describe('safeUrl', () => {
  it('assumes https for a bare domain, which is how people type them', () => {
    expect(safeUrl('acme.com')).toBe('https://acme.com/')
  })

  it('keeps an explicit scheme', () => {
    expect(safeUrl('http://acme.com/path')).toBe('http://acme.com/path')
  })

  it('allows mailto', () => {
    expect(safeUrl('mailto:buyer@acme.com')).toBe('mailto:buyer@acme.com')
  })

  // These values are rendered into href attributes, so anything that could
  // execute has to be refused rather than escaped.
  it('rejects javascript: urls', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('JavaScript:alert(1)')).toBeNull()
  })

  it('rejects data: urls', () => {
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(safeUrl('')).toBeNull()
    expect(safeUrl(null)).toBeNull()
    expect(safeUrl('   ')).toBeNull()
  })
})

describe('socialUrl', () => {
  it('turns a bare handle into a profile url', () => {
    expect(socialUrl('instagram', 'afmtrading')).toBe('https://instagram.com/afmtrading')
  })

  it('drops a leading @', () => {
    expect(socialUrl('x_twitter', '@afmtrading')).toBe('https://x.com/afmtrading')
  })

  it('puts the @ back for tiktok, which needs it in the path', () => {
    expect(socialUrl('tiktok', 'afmtrading')).toBe('https://tiktok.com/@afmtrading')
  })

  it('leaves a full url alone', () => {
    expect(socialUrl('facebook', 'https://facebook.com/afm/about')).toBe(
      'https://facebook.com/afm/about',
    )
  })

  it('returns null when unset', () => {
    expect(socialUrl('facebook', null)).toBeNull()
    expect(socialUrl('facebook', '  ')).toBeNull()
  })
})

describe('prettyUrl', () => {
  it('strips the scheme and trailing slash', () => {
    expect(prettyUrl('https://acme.com/')).toBe('acme.com')
    expect(prettyUrl('http://acme.com/team')).toBe('acme.com/team')
  })
})

describe('renderMarkdown', () => {
  it('renders paragraphs', () => {
    expect(renderMarkdown('Hello there')).toBe('<p>Hello there</p>')
  })

  it('renders bold and italic', () => {
    expect(renderMarkdown('**bold** and *italic*')).toContain('<strong>bold</strong>')
    expect(renderMarkdown('**bold** and *italic*')).toContain('<em>italic</em>')
  })

  it('renders bullet lists', () => {
    const html = renderMarkdown('- one\n- two')
    expect(html).toContain('<ul')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<li>two</li>')
  })

  it('renders numbered lists', () => {
    const html = renderMarkdown('1. first\n2. second')
    expect(html).toContain('<ol')
    expect(html).toContain('<li>first</li>')
  })

  it('closes a list before a following paragraph', () => {
    const html = renderMarkdown('- one\n\nafter')
    expect(html).toBe('<ul class="list-disc space-y-0.5 pl-5"><li>one</li></ul><p>after</p>')
  })

  it('renders headings', () => {
    expect(renderMarkdown('## Meeting notes')).toContain('font-semibold')
  })

  it('renders safe links', () => {
    const html = renderMarkdown('[site](https://acme.com)')
    expect(html).toContain('href="https://acme.com/"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  // The whole reason notes are stored as markdown rather than HTML.
  it('escapes html so a note cannot inject markup', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes an img onerror payload', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('drops a javascript: link but keeps its text', () => {
    const html = renderMarkdown('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('click')
  })

  it('does not let a quote break out of a link attribute', () => {
    const html = renderMarkdown('[x](https://acme.com/")onmouseover="alert(1))')
    expect(html).not.toContain('onmouseover="alert(1)"')
  })

  it('returns an empty string for blank notes', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(null)).toBe('')
    expect(renderMarkdown('   ')).toBe('')
  })
})

describe('daysUntilBirthday', () => {
  const today = new Date(2026, 7, 7) // 7 August 2026

  it('counts days to a birthday later this year', () => {
    expect(daysUntilBirthday('1980-08-10', today)).toBe(3)
  })

  it('returns 0 on the day itself', () => {
    expect(daysUntilBirthday('1980-08-07', today)).toBe(0)
  })

  // The case a naive month/day diff gets wrong.
  it('rolls over to next year once the date has passed', () => {
    expect(daysUntilBirthday('1980-08-06', today)).toBe(364)
  })

  it('handles a year-boundary birthday', () => {
    expect(daysUntilBirthday('1990-01-01', new Date(2026, 11, 29))).toBe(3)
  })

  it('returns null when no birthday is set', () => {
    expect(daysUntilBirthday(null, today)).toBeNull()
    expect(daysUntilBirthday('', today)).toBeNull()
  })
})
