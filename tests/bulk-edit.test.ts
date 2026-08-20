import { describe, expect, it } from 'vitest'

import {
  bulkFieldsFor,
  bulkResultMessage,
  inlineFieldsFor,
  validateBulkChange,
} from '../src/lib/bulk-edit'
import type { CustomFieldDefinitionRow, FieldOptionRow } from '../src/lib/database.types'

/*
 * The catalogue here and the whitelist inside bulk_update_records have to agree
 * — the database refuses anything it does not recognise, so a field offered
 * here but missing there is a dead entry in a dropdown. These tests pin the
 * shape of the offer; 12_bulk_update.sql pins what the database will accept.
 */

const definition = (
  attrs: Partial<CustomFieldDefinitionRow> &
    Pick<CustomFieldDefinitionRow, 'key' | 'label' | 'field_type'>,
): CustomFieldDefinitionRow =>
  ({
    id: attrs.key,
    organization_id: 'org',
    entity_type: 'company',
    options: null,
    order: 0,
    card: 'rating',
    created_at: '2026-01-01T00:00:00.000Z',
    ...attrs,
  }) as CustomFieldDefinitionRow

const option = (entity: string, key: string, value: string): FieldOptionRow =>
  ({
    id: `${key}:${value}`,
    organization_id: 'org',
    entity_type: entity,
    field_key: key,
    value,
    color: 'slate',
    order: 0,
  }) as FieldOptionRow

const empty = { owners: [], customFields: [], fieldOptions: [] }

describe('bulkFieldsFor', () => {
  it('offers a contact the fields that say where they sit, not who they are', () => {
    const keys = bulkFieldsFor('contact', empty).map((field) => field.key)

    expect(keys).toContain('owner_id')
    expect(keys).toContain('lifecycle_stage')
    expect(keys).toContain('role_type')
    // The manual override, which is a field like any other once it exists.
    expect(keys).toContain('mailable_override')
    // Identity is not a bulk operation. Nobody sets forty names at once, and a
    // field offered here is a field the database has been told to accept.
    expect(keys).not.toContain('first_name')
    expect(keys).not.toContain('email')
  })

  it('offers a company its own set', () => {
    const keys = bulkFieldsFor('company', empty).map((field) => field.key)

    expect(keys).toEqual(['owner_id', 'priority', 'specialty_market', 'customer_type'])
    expect(keys).not.toContain('name')
  })

  it('lets a list be amended and a single value only set or cleared', () => {
    const contact = bulkFieldsFor('contact', empty)

    expect(contact.find((field) => field.key === 'role_type')?.modes).toEqual([
      'set',
      'add',
      'remove',
      'clear',
    ])
    expect(contact.find((field) => field.key === 'owner_id')?.modes).toEqual(['set', 'clear'])
  })

  it('does not offer to clear a lifecycle stage, which is never empty', () => {
    const stage = bulkFieldsFor('contact', empty).find(
      (field) => field.key === 'lifecycle_stage',
    )
    expect(stage?.modes).toEqual(['set'])
  })

  it('carries an organization’s own fields, with the values they offer', () => {
    const fields = bulkFieldsFor('company', {
      owners: [],
      customFields: [definition({ key: 'regions', label: 'Regions', field_type: 'multiselect' })],
      fieldOptions: [option('company', 'regions', 'EMEA'), option('company', 'regions', 'APAC')],
    })

    const regions = fields.find((field) => field.key === 'custom_fields.regions')
    expect(regions?.label).toBe('Regions')
    expect(regions?.multiple).toBe(true)
    expect(regions?.options?.map((o) => o.value)).toEqual(['EMEA', 'APAC'])
    // Amending a list nested in JSON is not supported by the database function.
    expect(regions?.modes).toEqual(['set', 'clear'])
  })

  it('gives a free-text custom field no options, so the bar offers a text box', () => {
    const fields = bulkFieldsFor('company', {
      owners: [],
      customFields: [definition({ key: 'notes2', label: 'Internal ref', field_type: 'text' })],
      fieldOptions: [],
    })

    expect(fields.find((field) => field.key === 'custom_fields.notes2')?.options).toBeUndefined()
  })

  it('leaves out another record’s custom fields', () => {
    const fields = bulkFieldsFor('company', {
      owners: [],
      customFields: [
        definition({ key: 'theirs', label: 'Theirs', field_type: 'text', entity_type: 'contact' }),
      ],
      fieldOptions: [],
    })

    expect(fields.some((field) => field.key.startsWith('custom_fields.'))).toBe(false)
  })
})

describe('validateBulkChange', () => {
  // Found by key rather than position: an earlier version of this destructured
  // the array, and adding a field in the middle silently retargeted the tests.
  const contactFields = bulkFieldsFor('contact', {
    owners: [{ value: 'u1', label: 'Ada' }],
    customFields: [],
    fieldOptions: [option('contact', 'role_type', 'Champion')],
  })
  const byKey = (key: string) => contactFields.find((field) => field.key === key)
  const owner = byKey('owner_id')
  const roles = byKey('role_type')

  it('asks for a field before anything else', () => {
    expect(validateBulkChange(undefined, 'set', ['x'])).toMatch(/pick a field/i)
  })

  it('refuses a change the field does not offer', () => {
    expect(validateBulkChange(owner, 'add', ['u1'])).toMatch(/cannot be add/i)
  })

  it('asks for a value when one is needed', () => {
    expect(validateBulkChange(owner, 'set', [])).toMatch(/choose/i)
  })

  it('needs no value to clear', () => {
    expect(validateBulkChange(owner, 'clear', [])).toBeNull()
  })

  it('will not put several values in a field that holds one', () => {
    // Silently keeping one of them would be a decision nobody made.
    expect(validateBulkChange(owner, 'set', ['u1', 'u2'])).toMatch(/holds one value/i)
  })

  it('takes several for a list', () => {
    expect(validateBulkChange(roles, 'add', ['Champion', 'Buyer'])).toBeNull()
  })
})

describe('bulkResultMessage', () => {
  it('counts what changed', () => {
    expect(bulkResultMessage(12, 12, 'contact')).toBe('12 contacts updated.')
    expect(bulkResultMessage(1, 1, 'contact')).toBe('1 contact updated.')
  })

  it('pluralises a company the awkward way', () => {
    expect(bulkResultMessage(1, 1, 'company')).toBe('1 company updated.')
    expect(bulkResultMessage(4, 4, 'company')).toBe('4 companies updated.')
  })

  it('says out loud when some were skipped', () => {
    // Records a colleague owns are skipped by the row policies rather than
    // refused, so a silent partial success would look like a half-failure.
    expect(bulkResultMessage(8, 10, 'contact')).toBe(
      '8 contacts updated. 2 skipped — not yours to edit.',
    )
  })

  it('explains a change that reached nothing', () => {
    expect(bulkResultMessage(0, 5, 'contact')).toMatch(/nothing changed/i)
  })
})

/*
 * The bar and the cell read one catalogue and see different halves of it. The
 * point of these is that widening what a cell offers cannot widen what the bar
 * offers by accident — an email address set across forty records at once is
 * the mistake the split exists to prevent.
 */
describe('what a cell may change, against what the bar may', () => {
  const empty = { owners: [], companies: [], customFields: [], fieldOptions: [] }

  it('offers a contact the typed fields the bar does not', () => {
    const inline = inlineFieldsFor('contact', empty).map((field) => field.key)
    const bulk = bulkFieldsFor('contact', empty).map((field) => field.key)

    expect(inline).toEqual(expect.arrayContaining(['job_title', 'email', 'phone']))
    expect(bulk).not.toEqual(expect.arrayContaining(['job_title', 'email', 'phone']))
  })

  it('keeps everything the bar offers offered in a cell too', () => {
    const inline = new Set(inlineFieldsFor('contact', empty).map((field) => field.key))

    for (const field of bulkFieldsFor('contact', empty)) {
      expect(inline.has(field.key)).toBe(true)
    }
  })

  it('gives a company stock type, an address and a number', () => {
    const keys = inlineFieldsFor('company', empty).map((field) => field.key)

    expect(keys).toEqual(expect.arrayContaining(['stock_type', 'email', 'phone']))
  })

  it('gives a product everything, and the bar nothing', () => {
    const inline = inlineFieldsFor('product', empty).map((field) => field.key)

    expect(inline).toEqual([
      'status',
      'category',
      'product_condition',
      'priority',
      'brand',
      'sku',
      'unit_price',
      'unit_cost',
      'price_showroom',
      'price_wholesale',
    ])
    expect(bulkFieldsFor('product', empty)).toEqual([])
  })

  /* Retail and cost are NOT NULL with a zero default, so there is no clearing
     them — a price of nothing is zero, and the column would refuse null. */
  it('does not offer to clear a price that cannot be empty', () => {
    const fields = inlineFieldsFor('product', empty)

    expect(fields.find((field) => field.key === 'unit_price')?.modes).toEqual(['set'])
    expect(fields.find((field) => field.key === 'price_showroom')?.modes).toEqual(['set', 'clear'])
  })
})

describe('checking what was typed', () => {
  const field = (over: Record<string, unknown> = {}) =>
    inlineFieldsFor('contact', {
      owners: [],
      companies: [],
      customFields: [],
      fieldOptions: [],
    }).find((candidate) => candidate.key === (over.key ?? 'email'))!

  it('refuses something that is not an address', () => {
    expect(validateBulkChange(field(), 'set', ['acme.com'])).toBe(
      'acme.com is not an email address.',
    )
  })

  it('takes one that is', () => {
    expect(validateBulkChange(field(), 'set', ['buyer@acme.com'])).toBeNull()
  })

  it('still allows clearing, which is not a value to check', () => {
    expect(validateBulkChange(field(), 'clear', [])).toBeNull()
  })

  it('refuses a price that is not a number, and one below nothing', () => {
    const price = inlineFieldsFor('product', {
      owners: [],
      companies: [],
      customFields: [],
      fieldOptions: [],
    }).find((candidate) => candidate.key === 'unit_price')!

    expect(validateBulkChange(price, 'set', ['ninety'])).toBe('Retail price has to be a number.')
    expect(validateBulkChange(price, 'set', ['-1'])).toBe('Retail price cannot be negative.')
    expect(validateBulkChange(price, 'set', ['12.50'])).toBeNull()
  })

  it('holds a typed value to a length, so a paste cannot become a job title', () => {
    const title = inlineFieldsFor('contact', {
      owners: [],
      companies: [],
      customFields: [],
      fieldOptions: [],
    }).find((candidate) => candidate.key === 'job_title')!

    expect(validateBulkChange(title, 'set', ['x'.repeat(201)])).toBe(
      'Job title is longer than 200 characters.',
    )
  })
})

describe('a field that cannot be emptied', () => {
  it('says so in words rather than in the mode name', () => {
    const price = inlineFieldsFor('product', {
      owners: [],
      companies: [],
      customFields: [],
      fieldOptions: [],
    }).find((field) => field.key === 'unit_price')!

    expect(validateBulkChange(price, 'clear', [])).toBe('Retail price cannot be emptied.')
  })
})
