import { describe, expect, it } from 'vitest'

import {
  applyMergeFields,
  markdownToText,
  renderEmail,
  renderEmailBody,
} from '../src/lib/email/render'

const base = {
  subject: 'Hello',
  body: 'Just a line.',
  organizationName: 'FLO Ventures',
  unsubscribeUrl: 'https://crm.flo-ventures.com/unsubscribe?t=abc',
}

describe('renderEmailBody', () => {
  it('styles every element inline, because email clients ignore stylesheets', () => {
    const html = renderEmailBody('# Heading\n\nA paragraph.')
    expect(html).toContain('style="')
    // A class would mean nothing in Outlook and would be stripped by Gmail on
    // forwarding, so nothing here may depend on one.
    expect(html).not.toContain('class=')
  })

  it('renders the markdown subset the rest of the app uses', () => {
    const html = renderEmailBody('# Title\n\n- one\n- two\n\n1. first\n\nPlain.')
    expect(html).toContain('font-weight:600')
    expect(html).toContain('<ul')
    expect(html).toContain('<ol')
    expect(html).toContain('Plain.')
  })

  it('renders bold, italic and links', () => {
    const html = renderEmailBody('**bold** and *italic* and [a link](https://example.com)')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('href="https://example.com/"')
  })

  it('renders an image, which is the one thing a plain-text email cannot do', () => {
    const html = renderEmailBody('![A logo](https://example.com/logo.png)')
    expect(html).toContain('<img')
    expect(html).toContain('max-width:100%')
    expect(html).toContain('alt="A logo"')
  })

  it('escapes what somebody typed before it becomes markup', () => {
    const html = renderEmailBody('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('refuses a javascript: link rather than rendering it', () => {
    const html = renderEmailBody('[click me](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('click me')
  })

  it('refuses a javascript: image source too', () => {
    const html = renderEmailBody('![x](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<img')
  })
})

describe('renderEmail', () => {
  it('will not build a message without a working unsubscribe link', () => {
    // Enforced in the renderer rather than the template, so no campaign can be
    // sent without one however it was composed.
    expect(() => renderEmail({ ...base, unsubscribeUrl: '' })).toThrow(/unsubscribe/i)
    expect(() => renderEmail({ ...base, unsubscribeUrl: 'not a url' })).toThrow(/unsubscribe/i)
  })

  it('puts the unsubscribe link in both the HTML and the text', () => {
    const email = renderEmail(base)
    expect(email.html).toContain(base.unsubscribeUrl)
    expect(email.text).toContain(base.unsubscribeUrl)
  })

  it('always produces a text alternative', () => {
    // Not a fallback nobody reads: filters score a message with no text part
    // worse for that reason alone.
    const email = renderEmail(base)
    expect(email.text.length).toBeGreaterThan(0)
    expect(email.text).not.toContain('<')
  })

  it('prints the postal address when there is one', () => {
    const email = renderEmail({ ...base, postalAddress: '123 King St W, Toronto' })
    expect(email.html).toContain('123 King St W, Toronto')
    expect(email.text).toContain('123 King St W, Toronto')
  })

  it('manages without a postal address rather than printing an empty line', () => {
    const email = renderEmail({ ...base, postalAddress: null })
    expect(email.html).not.toContain('undefined')
    expect(email.text).not.toContain('null')
  })

  it('escapes the organization name, which nobody thinks of as user input', () => {
    const email = renderEmail({ ...base, organizationName: '<b>Acme</b>' })
    expect(email.html).not.toContain('<b>Acme</b>')
    expect(email.html).toContain('&lt;b&gt;Acme&lt;/b&gt;')
  })

  it('includes the logo only when given one', () => {
    expect(renderEmail({ ...base, logoUrl: 'https://example.com/l.png' }).html).toContain('<img')
    expect(renderEmail({ ...base, logoUrl: null }).html).not.toContain('<img')
  })
})

describe('applyMergeFields', () => {
  const values = { first_name: 'Aline', last_name: 'Alessi', company: 'bibi', email: 'a@b.com' }

  it('fills in what it knows', () => {
    expect(applyMergeFields('Hello {{first_name}} at {{company}}', values)).toBe(
      'Hello Aline at bibi',
    )
  })

  it('ignores spacing and case inside the braces', () => {
    expect(applyMergeFields('Hi {{ First_Name }}', values)).toBe('Hi Aline')
  })

  it('leaves an unknown field visible rather than blanking it', () => {
    // A typo should arrive looking wrong. Silently emptying it means nobody
    // notices until a hundred people have read "Hello ,".
    expect(applyMergeFields('Hello {{fist_name}}', values)).toBe('Hello {{fist_name}}')
  })

  it('empties a field that is known but not set', () => {
    expect(applyMergeFields('Hello {{first_name}}', { first_name: null })).toBe('Hello ')
  })

  it('replaces every occurrence, not just the first', () => {
    expect(applyMergeFields('{{first_name}} and {{first_name}}', values)).toBe('Aline and Aline')
  })
})

describe('markdownToText', () => {
  it('takes the syntax out and leaves the words', () => {
    // A delivered test showed `- **Bold** and *italic*` sitting in the text
    // part: unreadable to a text-only client, and a filter compares the two
    // halves of a multipart message against each other.
    expect(markdownToText('**Bold** and *italic*')).toBe('Bold and italic')
  })

  it('keeps a link readable by putting the address beside the words', () => {
    expect(markdownToText('[Links](https://example.com)')).toBe('Links (https://example.com)')
  })

  it('drops a heading marker but keeps the heading', () => {
    expect(markdownToText('## A title')).toBe('A title')
  })

  it('leaves an image as its alt text, which is all text can carry', () => {
    expect(markdownToText('![A logo](https://example.com/l.png)')).toBe('A logo')
  })

  it('leaves bullets and numbers alone — they read correctly as they are', () => {
    expect(markdownToText('- one\n1. two')).toBe('- one\n1. two')
  })

  it('leaves ordinary prose untouched', () => {
    expect(markdownToText('Just a sentence.')).toBe('Just a sentence.')
  })
})

describe('the rendered text part', () => {
  it('carries no markdown syntax at all', () => {
    const email = renderEmail({
      ...base,
      body: '# Title\n\n**Bold** and [a link](https://example.com)',
    })
    expect(email.text).not.toContain('**')
    expect(email.text).not.toContain('](')
    expect(email.text).toContain('Bold')
    expect(email.text).toContain('https://example.com')
  })
})
