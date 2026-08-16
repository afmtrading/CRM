import { describe, expect, it } from 'vitest'

import { bulkFieldsFor, bulkResultMessage, validateBulkChange } from '../src/lib/bulk-edit'
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
