import { describe, expect, it } from 'vitest'

import {
  FIELD_TYPES,
  MAPPING_TARGETS,
  embedSnippet,
  fieldKey,
  formUrl,
  parseAnswers,
  parseFields,
  readUtm,
  slugify,
  suggestSlug,
  whyNotPublishable,
  type FormField,
} from '../src/lib/forms'

const field = (over: Partial<FormField> = {}): FormField => ({
  key: 'email',
  label: 'Email address',
  type: 'email',
  required: true,
  maps_to: 'email',
  ...over,
})

describe('slugify', () => {
  it('turns a name into something that can live in a URL', () => {
    expect(slugify('Request a pallet quote')).toBe('request-a-pallet-quote')
  })

  it('drops accents rather than escaping them', () => {
    expect(slugify('Demande de prix — Québec')).toBe('demande-de-prix-quebec')
  })

  it('never ends on a hyphen, however it was cut short', () => {
    expect(slugify('!!!')).toBe('')
    expect(slugify('a'.repeat(60)).endsWith('-')).toBe(false)
  })
})

describe('suggestSlug', () => {
  it('appends the random suffix that stops one account squatting another’s name', () => {
    expect(suggestSlug('Contact us', 'A1B2C3D4')).toBe('contact-us-a1b2c3')
  })

  it('still produces an address for a name with nothing usable in it', () => {
    expect(suggestSlug('***', 'zz9')).toBe('form-zz9')
  })
})

describe('fieldKey', () => {
  it('derives a key from the label', () => {
    expect(fieldKey('Company name', [])).toBe('company_name')
  })

  it('does not collide with a key already in use', () => {
    expect(fieldKey('Company name', ['company_name'])).toBe('company_name_2')
  })

  it('always starts with a letter, because the database insists', () => {
    expect(fieldKey('2026 budget', [])).toMatch(/^[a-z]/)
  })
})

describe('parseFields', () => {
  it('reads back what the builder wrote', () => {
    const fields = parseFields([
      { key: 'email', label: 'Email', type: 'email', required: true, maps_to: 'email' },
    ])
    expect(fields).toHaveLength(1)
    expect(fields[0].maps_to).toBe('email')
  })

  it('drops entries that are not questions rather than rendering half of one', () => {
    expect(parseFields([null, 'nope', { label: 'No key' }, { key: 'k' }])).toEqual([])
  })

  it('falls back to a plain text box for a type it does not know', () => {
    const [only] = parseFields([{ key: 'a', label: 'A', type: 'signature' }])
    expect(only.type).toBe('text')
  })

  it('treats anything that is not a list as no questions at all', () => {
    expect(parseFields(null)).toEqual([])
    expect(parseFields({ key: 'email' })).toEqual([])
  })
})

describe('whyNotPublishable', () => {
  it('lets a complete form through', () => {
    expect(whyNotPublishable([field()])).toBeNull()
  })

  it('refuses a form nobody can be identified from', () => {
    // The failure this exists for: a live form quietly collecting answers that
    // can never become a contact.
    expect(whyNotPublishable([field({ key: 'msg', maps_to: '', type: 'textarea' })])).toContain(
      'email address',
    )
  })

  it('refuses two questions filling the same field', () => {
    expect(whyNotPublishable([field(), field({ key: 'email2' })])).toContain('both fill')
  })

  it('refuses a full name asked for twice over', () => {
    const problem = whyNotPublishable([
      field(),
      field({ key: 'name', label: 'Name', type: 'text', maps_to: 'full_name' }),
      field({ key: 'first', label: 'First', type: 'text', maps_to: 'first_name' }),
    ])
    expect(problem).toContain('not both')
  })

  it('refuses a choose-one question with nothing to choose', () => {
    const problem = whyNotPublishable([
      field(),
      field({ key: 'size', label: 'Pallets', type: 'select', maps_to: '', options: [] }),
    ])
    expect(problem).toContain('no options')
  })

  it('refuses an empty form', () => {
    expect(whyNotPublishable([])).toContain('at least one')
  })
})

describe('the fields a form may fill', () => {
  it('offers no way to set the owner, the score or the consent basis', () => {
    // Those are decided by the form's settings or by a rule. A question that
    // could set them would be letting a stranger choose.
    const values = MAPPING_TARGETS.map((target) => target.value)
    expect(values).not.toContain('owner_id')
    expect(values).not.toContain('lead_score')
    expect(values).not.toContain('marketing_consent')
    expect(values).not.toContain('lifecycle_stage')
  })

  it('keeps an answer on the submission when it maps to nothing', () => {
    expect(MAPPING_TARGETS[0].value).toBe('')
  })

  it('has a hint on every question type, since the picker is the only explanation', () => {
    expect(FIELD_TYPES.every((type) => type.hint.length > 0)).toBe(true)
  })
})

describe('parseAnswers', () => {
  it('keeps the label that was frozen onto the submission', () => {
    expect(parseAnswers([{ key: 'q', label: 'What are you after?', value: 'Pallets' }])).toEqual([
      { key: 'q', label: 'What are you after?', value: 'Pallets' },
    ])
  })

  it('skips an entry with no label rather than rendering a blank row', () => {
    expect(parseAnswers([{ key: 'q', value: 'x' }])).toEqual([])
  })
})

describe('readUtm', () => {
  it('keeps the five that campaigns are actually tagged with', () => {
    expect(
      readUtm({ utm_source: 'linkedin', utm_medium: 'cpc', ref: 'ignored', utm_campaign: '' }),
    ).toEqual({ utm_source: 'linkedin', utm_medium: 'cpc' })
  })

  it('takes the first value when a parameter is repeated', () => {
    expect(readUtm({ utm_source: ['a', 'b'] })).toEqual({ utm_source: 'a' })
  })
})

describe('sharing', () => {
  it('builds the public address without doubling the slash', () => {
    expect(formUrl('https://crm.example.com/', 'quote-abc123')).toBe(
      'https://crm.example.com/f/quote-abc123',
    )
  })

  it('hands out an iframe rather than a script tag', () => {
    const snippet = embedSnippet('https://crm.example.com/f/quote-abc123')
    expect(snippet).toContain('<iframe')
    expect(snippet).not.toContain('<script')
  })
})
