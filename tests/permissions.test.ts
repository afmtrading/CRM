import { describe, expect, it } from 'vitest'

import {
  CAPABILITIES,
  VISIBILITY_OPTIONS,
  describeSet,
  visibilityColumns,
  visibilityOf,
} from '@/lib/permissions'
import type { PermissionSetRow } from '@/lib/database.types'

function set(overrides: Partial<PermissionSetRow> = {}): PermissionSetRow {
  return {
    id: 'set',
    organization_id: 'org',
    name: 'A set',
    role: null,
    see_all_records: false,
    see_unassigned: false,
    write_records: false,
    delete_records: false,
    manage_records: false,
    bulk_records: false,
    administer: false,
    manage_permissions: false,
    see_hidden: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('record visibility', () => {
  it('reads the three states off the two columns', () => {
    expect(visibilityOf(set({ see_all_records: true, see_unassigned: true }))).toBe('all')
    expect(visibilityOf(set({ see_unassigned: true }))).toBe('own_and_unassigned')
    expect(visibilityOf(set())).toBe('own')
  })

  it('treats see_all as decisive, whatever see_unassigned says', () => {
    // Not reachable through the screen, but reachable in the database, and
    // "sees everything" is the honest reading of it.
    expect(visibilityOf(set({ see_all_records: true, see_unassigned: false }))).toBe('all')
  })

  it('round-trips every option', () => {
    for (const option of VISIBILITY_OPTIONS) {
      expect(visibilityOf(set(visibilityColumns(option.value)))).toBe(option.value)
    }
  })

  it('falls to the narrowest for anything it does not recognise', () => {
    expect(visibilityColumns('everything')).toEqual({
      see_all_records: false,
      see_unassigned: false,
    })
    expect(visibilityColumns('')).toEqual({ see_all_records: false, see_unassigned: false })
  })
})

describe('describing a set', () => {
  it('says read only when nothing is ticked', () => {
    expect(describeSet(set())).toBe('Only their own. Read only — nothing else is ticked.')
  })

  it('lists what is granted', () => {
    expect(describeSet(set({ see_all_records: true, see_unassigned: true, write_records: true }))).toBe(
      'Every record in the organization. create and edit.',
    )
  })

  it('names every capability it has a column for', () => {
    const everything = set(
      Object.fromEntries(CAPABILITIES.map((capability) => [capability.key, true])),
    )
    for (const capability of CAPABILITIES) {
      expect(describeSet(everything).toLowerCase()).toContain(capability.label.toLowerCase())
    }
  })
})

describe('the capability list', () => {
  it('has no duplicate keys', () => {
    const keys = CAPABILITIES.map((capability) => capability.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('puts the ones that hand over the building last', () => {
    const keys = CAPABILITIES.map((capability) => capability.key)
    expect(keys.slice(-3)).toEqual(['administer', 'see_hidden', 'manage_permissions'])
  })
})
