import { describe, expect, it } from 'vitest'

import {
  chosenValues,
  definitionsFor,
  definitionsOnCard,
  displayValue,
  hasAnyValue,
  readCustomFields,
} from '../src/lib/custom-fields'
import type { CustomFieldDefinitionRow } from '../src/lib/database.types'

function definition(over: Partial<CustomFieldDefinitionRow> = {}): CustomFieldDefinitionRow {
  return {
    id: 'f1',
    organization_id: 'org',
    entity_type: 'deal',
    key: 'incoterm',
    label: 'Incoterm',
    field_type: 'text',
    options: [],
    card: 'details',
    order: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

describe('reading custom fields off a form', () => {
  it('picks up only the custom.* inputs', () => {
    const form = new FormData()
    form.set('name', 'A deal')
    form.set('custom.incoterm', 'FOB')

    expect(readCustomFields(form)).toEqual({ incoterm: 'FOB' })
  })

  it('keeps a repeated key as an array, matching how a multiselect renders back', () => {
    const form = new FormData()
    form.append('custom.markets', 'Retail')
    form.append('custom.markets', 'Export')

    expect(readCustomFields(form)).toEqual({ markets: ['Retail', 'Export'] })
  })

  /*
   * A field nobody filled in should be absent, not present and blank — otherwise
   * every record grows a key for every field an admin has ever defined, and a
   * cleared value is indistinguishable from an empty one.
   */
  it('drops empty and whitespace-only values entirely', () => {
    const form = new FormData()
    form.set('custom.blank', '')
    form.set('custom.spaces', '   ')
    form.set('custom.kept', ' FOB ')

    expect(readCustomFields(form)).toEqual({ kept: 'FOB' })
  })

  it('drops a multiselect where every option was cleared', () => {
    const form = new FormData()
    form.append('custom.markets', '')
    form.append('custom.markets', '  ')

    expect(readCustomFields(form)).toEqual({})
  })

  it('returns nothing for a form with no custom fields at all', () => {
    const form = new FormData()
    form.set('name', 'A deal')
    expect(readCustomFields(form)).toEqual({})
  })

  it('does not mistake a field merely containing "custom" for a custom field', () => {
    const form = new FormData()
    form.set('customer_name', 'ACME')
    expect(readCustomFields(form)).toEqual({})
  })
})

describe('selecting definitions', () => {
  const definitions = [
    definition({ id: 'a', entity_type: 'deal', key: 'incoterm', order: 1 }),
    definition({ id: 'b', entity_type: 'deal', key: 'broker', order: 0, card: 'additional' }),
    definition({ id: 'c', entity_type: 'contact', key: 'tier' }),
  ]

  it('keeps a definition on the record it was defined for', () => {
    expect(definitionsFor(definitions, 'deal').map((d) => d.id)).toEqual(['b', 'a'])
    expect(definitionsFor(definitions, 'contact').map((d) => d.id)).toEqual(['c'])
  })

  it('returns them in the order an admin arranged', () => {
    expect(definitionsFor(definitions, 'deal').map((d) => d.key)).toEqual(['broker', 'incoterm'])
  })

  it('splits them by card', () => {
    expect(definitionsOnCard(definitions, 'deal', 'details').map((d) => d.id)).toEqual(['a'])
    expect(definitionsOnCard(definitions, 'deal', 'additional').map((d) => d.id)).toEqual(['b'])
  })
})

describe('showing a value', () => {
  it('joins a list', () => {
    expect(displayValue(['Retail', 'Export'])).toBe('Retail, Export')
  })

  it('reads a missing value as nothing rather than as "undefined"', () => {
    expect(displayValue(undefined)).toBe('')
    expect(displayValue(null)).toBe('')
  })

  it('says yes or no rather than true or false', () => {
    expect(displayValue(true)).toBe('Yes')
    expect(displayValue(false)).toBe('No')
  })

  it('keeps a zero, which is a value somebody entered', () => {
    expect(displayValue(0)).toBe('0')
  })

  it('knows whether a card has anything worth drawing', () => {
    const fields = [definition({ key: 'incoterm' })]
    expect(hasAnyValue(fields, {})).toBe(false)
    expect(hasAnyValue(fields, { incoterm: '' })).toBe(false)
    expect(hasAnyValue(fields, { incoterm: 'FOB' })).toBe(true)
  })
})

describe('a stored value as the list an editable cell picks from', () => {
  it('wraps a single value', () => {
    expect(chosenValues('Champion')).toEqual(['Champion'])
  })

  it('keeps a multiselect as it is', () => {
    expect(chosenValues(['Champion', 'Decision maker'])).toEqual(['Champion', 'Decision maker'])
  })

  it('reads absence as nothing chosen', () => {
    expect(chosenValues(null)).toEqual([])
    expect(chosenValues(undefined)).toEqual([])
    expect(chosenValues('')).toEqual([])
    expect(chosenValues([])).toEqual([])
  })

  it('drops the blanks inside a list rather than offering an empty chip', () => {
    expect(chosenValues(['Champion', '', null])).toEqual(['Champion'])
  })

  it('stringifies what is not text, because an option list can be numbers', () => {
    expect(chosenValues(3)).toEqual(['3'])
    expect(chosenValues(false)).toEqual(['false'])
  })
})
