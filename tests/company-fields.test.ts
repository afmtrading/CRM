import { describe, expect, it } from 'vitest'

import { companyFieldValues, findCompanyField } from '../src/lib/company-fields'
import type { CustomFieldDefinitionRow } from '../src/lib/database.types'

/*
 * Region and size are the organization's own fields, named by whoever created
 * them, so the list columns have to go looking. These tests pin down how far
 * that search reaches — far enough to survive "Company size", not so far that
 * it starts answering with the wrong field.
 */

const field = (
  attrs: Partial<CustomFieldDefinitionRow> & Pick<CustomFieldDefinitionRow, 'key' | 'label'>,
): CustomFieldDefinitionRow =>
  ({
    id: attrs.key,
    organization_id: 'org',
    entity_type: 'company',
    field_type: 'select',
    options: null,
    order: 0,
    card: 'rating',
    created_at: '2026-01-01T00:00:00.000Z',
    ...attrs,
  }) as CustomFieldDefinitionRow

describe('findCompanyField', () => {
  it('finds the field by its label', () => {
    const fields = [field({ key: 'f1', label: 'Size' })]
    expect(findCompanyField(fields, 'size')?.key).toBe('f1')
  })

  it('finds it by key when the label was written differently', () => {
    const fields = [field({ key: 'size', label: 'How big are they' })]
    expect(findCompanyField(fields, 'size')?.key).toBe('size')
  })

  it('does not care about case or stray spaces', () => {
    const fields = [field({ key: 'f1', label: '  REGIONS ' })]
    expect(findCompanyField(fields, 'regions', 'region')?.key).toBe('f1')
  })

  it('accepts either spelling when several are offered', () => {
    const fields = [field({ key: 'f1', label: 'Region' })]
    expect(findCompanyField(fields, 'regions', 'region')?.key).toBe('f1')
  })

  it('falls back to a field that contains the word', () => {
    // The reported problem: the column was blank because the field is called
    // "Company size" and the match demanded exactly "size".
    const fields = [field({ key: 'f1', label: 'Company size' })]
    expect(findCompanyField(fields, 'size')?.key).toBe('f1')
  })

  it('matches a word inside an underscored key', () => {
    const fields = [field({ key: 'company_size', label: 'How big' })]
    expect(findCompanyField(fields, 'size')?.key).toBe('company_size')
  })

  it('prefers the exact name when both exist, whatever order they arrive in', () => {
    const fields = [field({ key: 'f1', label: 'Company size' }), field({ key: 'f2', label: 'Size' })]
    expect(findCompanyField(fields, 'size')?.key).toBe('f2')
  })

  it('matches whole words only, so a longer word does not answer', () => {
    // "Sizing chart" is not the size of the company.
    const fields = [field({ key: 'f1', label: 'Sizing chart' })]
    expect(findCompanyField(fields, 'size')).toBeUndefined()
  })

  it('ignores fields belonging to another record', () => {
    const fields = [field({ key: 'f1', label: 'Size', entity_type: 'contact' })]
    expect(findCompanyField(fields, 'size')).toBeUndefined()
  })

  it('finds nothing rather than guessing when no field is close', () => {
    const fields = [field({ key: 'f1', label: 'Stock type' })]
    expect(findCompanyField(fields, 'size')).toBeUndefined()
    expect(findCompanyField([], 'size')).toBeUndefined()
  })
})

describe('companyFieldValues', () => {
  const size = field({ key: 'size', label: 'Size' })

  it('reads a multi-select as the list it is', () => {
    expect(companyFieldValues({ custom_fields: { size: ['Large', 'Regional'] } }, size)).toEqual([
      'Large',
      'Regional',
    ])
  })

  it('reads a single-select as a list of one, so the caller renders it the same way', () => {
    expect(companyFieldValues({ custom_fields: { size: 'Large' } }, size)).toEqual(['Large'])
  })

  it('has nothing to show for an unset field', () => {
    expect(companyFieldValues({ custom_fields: {} }, size)).toEqual([])
    expect(companyFieldValues({ custom_fields: { size: '' } }, size)).toEqual([])
    expect(companyFieldValues({ custom_fields: { size: null } }, size)).toEqual([])
  })

  it('has nothing to show for a contact with no company', () => {
    expect(companyFieldValues(null, size)).toEqual([])
  })

  it('has nothing to show when the field was never defined', () => {
    expect(companyFieldValues({ custom_fields: { size: 'Large' } }, undefined)).toEqual([])
  })
})
