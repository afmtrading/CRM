import { describe, expect, it } from 'vitest'

import {
  columnCatalogue,
  defaultColumns,
  moveColumn,
  normaliseSelection,
  resolveColumns,
} from '@/lib/table-columns'
import type { CustomFieldDefinitionRow } from '@/lib/database.types'

function customField(key: string, label: string, entity = 'contact'): CustomFieldDefinitionRow {
  return {
    id: key,
    organization_id: 'org',
    entity_type: entity,
    key,
    label,
    field_type: 'text',
    options: [],
    order: 0,
    card: null,
    created_at: '2026-01-01T00:00:00Z',
  } as unknown as CustomFieldDefinitionRow
}

describe('columnCatalogue', () => {
  it('offers a column for each custom field, after the built-in ones', () => {
    const catalogue = columnCatalogue('contact', [customField('tier', 'Tier')])

    expect(catalogue.at(-1)).toEqual({ key: 'custom_fields.tier', label: 'Tier' })
  })

  it('ignores custom fields belonging to another entity', () => {
    const catalogue = columnCatalogue('contact', [customField('regions', 'Regions', 'company')])

    expect(catalogue.some((column) => column.key === 'custom_fields.regions')).toBe(false)
  })

  it('has exactly one locked column per list', () => {
    for (const entity of ['contact', 'company', 'product'] as const) {
      expect(columnCatalogue(entity).filter((column) => column.locked)).toHaveLength(1)
    }
  })

  /*
   * A default naming a column the catalogue does not have would silently
   * vanish, and the list would come up one column short with nothing to say so.
   */
  it('can render every default it ships with', () => {
    for (const entity of ['contact', 'company', 'product'] as const) {
      const keys = new Set(columnCatalogue(entity).map((column) => column.key))
      for (const key of defaultColumns(entity)) {
        expect(keys.has(key), `${entity} default ${key}`).toBe(true)
      }
    }
  })
})

describe('resolveColumns', () => {
  it('falls back to the defaults when nothing is saved', () => {
    expect(resolveColumns('contact', null).map((c) => c.key)).toEqual(defaultColumns('contact'))
    expect(resolveColumns('contact', []).map((c) => c.key)).toEqual(defaultColumns('contact'))
  })

  it('honours the saved order rather than the catalogue order', () => {
    const resolved = resolveColumns('contact', ['name', 'credibility', 'owner', 'email'])

    expect(resolved.map((c) => c.key)).toEqual(['name', 'credibility', 'owner', 'email'])
  })

  // A custom field somebody deleted would otherwise render a column of blanks
  // for everybody who had chosen it, forever.
  it('drops a key the catalogue no longer has', () => {
    const resolved = resolveColumns('contact', ['name', 'custom_fields.gone', 'owner'])

    expect(resolved.map((c) => c.key)).toEqual(['name', 'owner'])
  })

  it('puts the locked column back, and first, if it is missing', () => {
    const resolved = resolveColumns('contact', ['owner', 'priority'])

    expect(resolved.map((c) => c.key)).toEqual(['name', 'owner', 'priority'])
  })

  it('does not move the locked column when it was saved somewhere else', () => {
    const resolved = resolveColumns('contact', ['owner', 'name', 'priority'])

    expect(resolved[0].key).toBe('name')
    expect(resolved.map((c) => c.key)).toEqual(['name', 'owner', 'priority'])
  })

  // A header row and a body row that disagree about how many cells there are is
  // a broken table, not a cosmetic problem.
  it('collapses a duplicate rather than rendering one column twice', () => {
    const resolved = resolveColumns('contact', ['name', 'owner', 'owner'])

    expect(resolved.map((c) => c.key)).toEqual(['name', 'owner'])
  })

  it('resolves a custom field when the catalogue includes it', () => {
    const catalogue = columnCatalogue('contact', [customField('tier', 'Tier')])
    const resolved = resolveColumns('contact', ['name', 'custom_fields.tier'], catalogue)

    expect(resolved.map((c) => c.label)).toEqual(['Name', 'Tier'])
  })

  it('never returns an empty table', () => {
    expect(resolveColumns('company', ['custom_fields.nothing']).map((c) => c.key)).toEqual(['name'])
  })
})

describe('normaliseSelection', () => {
  /*
   * Symmetry is the property that matters: what the picker sends is what the
   * table renders. If these two ever disagree, somebody saves a layout and gets
   * a different one back.
   */
  it('round-trips through resolveColumns unchanged', () => {
    const chosen = ['name', 'region', 'owner']
    const stored = normaliseSelection('contact', chosen)

    expect(stored).toEqual(chosen)
    expect(resolveColumns('contact', stored).map((c) => c.key)).toEqual(chosen)
  })

  it('refuses a key that names no column', () => {
    expect(normaliseSelection('product', ['name', 'made_up'])).toEqual(['name'])
  })
})

describe('moveColumn', () => {
  const items = ['a', 'b', 'c', 'd']

  it('moves an item down', () => {
    expect(moveColumn(items, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an item up', () => {
    expect(moveColumn(items, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('leaves the list alone for a move that goes nowhere', () => {
    expect(moveColumn(items, 1, 1)).toBe(items)
  })

  // The picker's arrow buttons are disabled at the ends, but a drag past the
  // last row can still report an index nobody has.
  it('leaves the list alone for an index off either end', () => {
    expect(moveColumn(items, -1, 2)).toBe(items)
    expect(moveColumn(items, 0, 9)).toBe(items)
  })

  it('does not mutate the list it was given', () => {
    const original = [...items]
    moveColumn(items, 0, 3)
    expect(items).toEqual(original)
  })
})
