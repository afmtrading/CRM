import { describe, expect, it } from 'vitest'

import {
  CONTACT_IMPORT_FIELDS,
  COMPANY_IMPORT_FIELDS,
  mapRow,
  suggestMapping,
  toContactPayload,
  toCsv,
} from '@/lib/csv'

describe('suggestMapping', () => {
  it('matches headers by field key and label', () => {
    const mapping = suggestMapping(['first_name', 'Last name', 'Email'], CONTACT_IMPORT_FIELDS)

    expect(mapping).toMatchObject({
      first_name: 'first_name',
      'Last name': 'last_name',
      Email: 'email',
    })
  })

  it('understands the spellings other systems export', () => {
    const mapping = suggestMapping(
      ['First Name', 'Surname', 'E-mail Address', 'Mobile', 'Company', 'Lead Source'],
      CONTACT_IMPORT_FIELDS,
    )

    expect(mapping).toMatchObject({
      'First Name': 'first_name',
      Surname: 'last_name',
      'E-mail Address': 'email',
      Mobile: 'phone',
      Company: 'company_name',
      'Lead Source': 'source',
    })
  })

  it('leaves unrecognised headers unmapped rather than guessing', () => {
    const mapping = suggestMapping(['Internal Ref 42'], CONTACT_IMPORT_FIELDS)
    expect(mapping['Internal Ref 42']).toBeUndefined()
  })
})

describe('mapRow', () => {
  const mapping = {
    'First Name': 'first_name',
    'Last Name': 'last_name',
    Email: 'email',
    Stage: 'lifecycle_stage',
    Tier: 'custom_fields.tier',
    Notes: '__skip__',
  }

  it('maps and trims values', () => {
    const row = mapRow(
      { 'First Name': ' Ada ', 'Last Name': 'Lovelace', Email: 'ada@example.com', Stage: 'lead', Tier: 'gold', Notes: 'ignore me' },
      mapping,
      CONTACT_IMPORT_FIELDS,
      2,
    )

    expect(row.errors).toEqual([])
    expect(row.values).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' })
    expect(row.customFields).toEqual({ tier: 'gold' })
    expect(row.values.notes).toBeUndefined()
  })

  it('reports an invalid email instead of importing it', () => {
    const row = mapRow({ 'First Name': 'Ada', Email: 'not-an-email' }, mapping, CONTACT_IMPORT_FIELDS, 5)

    expect(row.rowNumber).toBe(5)
    expect(row.errors).toHaveLength(1)
    expect(row.errors[0]).toContain('not a valid email')
  })

  it('reports an out-of-range enum value', () => {
    const row = mapRow(
      { 'First Name': 'Ada', Stage: 'prospect' },
      mapping,
      CONTACT_IMPORT_FIELDS,
      3,
    )

    expect(row.errors[0]).toContain('must be one of')
  })

  it('rejects a row with nothing to identify the contact by', () => {
    const row = mapRow({ Notes: 'just a note' }, mapping, CONTACT_IMPORT_FIELDS, 9)
    expect(row.errors[0]).toContain('at least a first name')
  })

  it('reports a missing required field for companies', () => {
    const row = mapRow({ Domain: 'acme.com' }, { Domain: 'domain' }, COMPANY_IMPORT_FIELDS, 2)
    expect(row.errors[0]).toContain('Name is required')
  })

  it('never throws on malformed input — it reports', () => {
    expect(() => mapRow({}, mapping, CONTACT_IMPORT_FIELDS, 1)).not.toThrow()
  })
})

describe('toContactPayload', () => {
  it('normalises the email and defaults the lifecycle stage', () => {
    const row = mapRow(
      { A: 'Ada', B: 'ADA@EXAMPLE.COM' },
      { A: 'first_name', B: 'email' },
      CONTACT_IMPORT_FIELDS,
      2,
    )

    const payload = toContactPayload(row)
    expect(payload.email).toBe('ada@example.com')
    expect(payload.lifecycle_stage).toBe('lead')
  })

  it('falls back to lead when the stage is not one we know', () => {
    const row = mapRow({ A: 'Ada', S: 'prospect' }, { A: 'first_name', S: 'lifecycle_stage' }, CONTACT_IMPORT_FIELDS, 2)
    expect(toContactPayload(row).lifecycle_stage).toBe('lead')
  })

  it('splits a tag list', () => {
    const row = mapRow(
      { A: 'Ada', T: 'VIP, Toronto , ' },
      { A: 'first_name', T: 'tags' },
      CONTACT_IMPORT_FIELDS,
      2,
    )

    expect(toContactPayload(row).tags).toEqual(['VIP', 'Toronto'])
  })
})

describe('toCsv', () => {
  it('writes a header row and values', () => {
    expect(toCsv([{ a: 1, b: 'two' }])).toBe('a,b\n1,two')
  })

  it('quotes values containing commas, quotes or newlines', () => {
    const csv = toCsv([{ note: 'Hello, "world"\nsecond line' }])
    expect(csv).toBe('note\n"Hello, ""world""\nsecond line"')
  })

  it('writes empty cells for null and undefined', () => {
    expect(toCsv([{ a: null, b: undefined, c: 0 }])).toBe('a,b,c\n,,0')
  })

  it('serialises nested objects, so custom fields survive an export', () => {
    expect(toCsv([{ custom_fields: { tier: 'gold' } }])).toBe('custom_fields\n"{""tier"":""gold""}"')
  })

  it('unions keys across rows so a sparse row does not drop columns', () => {
    expect(toCsv([{ a: 1 }, { b: 2 }])).toBe('a,b\n1,\n,2')
  })

  it('still emits headers for an empty result set', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b')
  })
})
