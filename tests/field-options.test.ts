import { describe, expect, it } from 'vitest'

import {
  ALL_CARDS,
  OPTION_ENTITIES,
  OPTION_FIELDS,
  PRODUCT_CARDS,
  cardLabel,
  daysUntilBirthday,
  optionOwners,
  optionsForField,
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

  it('does the same for a youtube handle', () => {
    expect(socialUrl('youtube', 'afmtrading')).toBe('https://youtube.com/@afmtrading')
  })

  // A channel is also reached by /channel/UC… or an old /c/ path, neither of
  // which fits the @handle base — so a full URL has to pass through untouched.
  it('leaves a youtube channel url alone', () => {
    expect(socialUrl('youtube', 'https://youtube.com/channel/UC123')).toBe(
      'https://youtube.com/channel/UC123',
    )
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

describe('cards across record types', () => {
  it('names the same card differently on each record', () => {
    expect(cardLabel('contact', 'details')).toBe('Contact details')
    expect(cardLabel('company', 'details')).toBe('Company info')
    expect(cardLabel('product', 'details')).toBe('Product details')
  })

  it('gives products a pricing card that no other record has', () => {
    expect(PRODUCT_CARDS.map((card) => card.key)).toContain('pricing')
    expect(cardLabel('product', 'pricing')).toBe('Pricing')
  })

  it('offers every card key in the settings picker', () => {
    const offered = new Set(ALL_CARDS.map((card) => card.key))
    for (const card of PRODUCT_CARDS) expect(offered.has(card.key)).toBe(true)
  })
})

describe('option owners', () => {
  it('lists product categories as a built-in list an admin can fill in', () => {
    const owner = optionOwners([]).find((candidate) => candidate.key === 'product_category')
    expect(owner).toMatchObject({ entity: 'product', builtIn: true, multiple: false })
  })

  it('keeps a custom field on the record it was defined for', () => {
    const owners = optionOwners([
      { key: 'grade', label: 'Grade', entity_type: 'product', field_type: 'select', card: 'details' },
    ])
    expect(owners.find((owner) => owner.key === 'grade')?.entity).toBe('product')
  })

  it('separates identically keyed lists on different records', () => {
    const options = [
      { entity_type: 'product', field_key: 'grade', value: 'A' },
      { entity_type: 'contact', field_key: 'grade', value: 'Warm' },
    ]
    expect(optionsForField(options, 'product', 'grade')).toEqual([options[0]])
    expect(optionsForField(options, 'contact', 'grade')).toEqual([options[1]])
  })

  it('declares each built-in list against exactly one record type', () => {
    const seen = new Set(OPTION_FIELDS.map((field) => `${field.entity}.${field.key}`))
    expect(seen.size).toBe(OPTION_FIELDS.length)
  })

  it('offers loss reasons as a deal list an admin can rewrite', () => {
    const owner = optionOwners([]).find((candidate) => candidate.key === 'loss_reason')
    expect(owner).toMatchObject({ entity: 'deal', builtIn: true, multiple: false })
  })

  /*
   * A deal was kept out of this picker until it had somewhere to render a
   * field. It has two cards now, so offering it no longer promises a field that
   * never appears.
   */
  it('offers a deal as a record type for new custom fields', () => {
    expect(OPTION_ENTITIES.map((entity) => entity.value)).toContain('deal')
  })

  it('keeps a custom field defined on a deal on the deal', () => {
    const owners = optionOwners([
      { key: 'incoterm', label: 'Incoterm', entity_type: 'deal', field_type: 'select', card: 'details' },
    ])
    expect(owners.find((owner) => owner.key === 'incoterm')?.entity).toBe('deal')
  })

  it('names the deal cards', () => {
    expect(cardLabel('deal', 'additional')).toBe('Additional info')
    expect(cardLabel('deal', 'details')).toBe('Details')
  })
})

/*
 * Priority is one question asked of three record types, and it drifted: two
 * lists rendered as chips and one as a dropdown, and a product had none at all.
 * These pin the shape rather than the wording — an organization owns the values,
 * but not whether the question is a single choice.
 */
describe('priority, asked the same way everywhere', () => {
  const priorities = OPTION_FIELDS.filter((field) => field.key === 'priority')

  it('is offered on a contact, a company and a product', () => {
    expect(priorities.map((field) => field.entity).sort()).toEqual([
      'company',
      'contact',
      'product',
    ])
  })

  it('is a single choice on every one of them', () => {
    expect(priorities.every((field) => field.multiple === false)).toBe(true)
  })

  it('is labelled the same on every one of them', () => {
    expect(new Set(priorities.map((field) => field.label))).toEqual(new Set(['Priority']))
  })

  /*
   * A marketplace is deliberately absent: it is a company and reads the
   * company's priority, and 20260247 dropped the one it briefly had of its own.
   * There is no assertion for that here because there cannot be one — an
   * OptionFieldKey of `marketplace_priority` does not typecheck, so putting the
   * list back would fail the build before it could fail a test.
   */
  it('draws one record type at a time', () => {
    const options = [
      { entity_type: 'contact', field_key: 'priority', value: 'High' },
      { entity_type: 'company', field_key: 'priority', value: 'High' },
      { entity_type: 'product', field_key: 'priority', value: 'High' },
    ]
    for (const entity of ['contact', 'company', 'product']) {
      expect(optionsForField(options, entity, 'priority')).toHaveLength(1)
    }
  })
})
