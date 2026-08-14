import { describe, expect, it } from 'vitest'

import { conditionToPredicate, operatorsFor, OPERATOR_LABELS } from '@/lib/filters'
import type { FilterOperator } from '@/lib/filters'

/**
 * The three queries this whole feature exists for, expressed as the predicates
 * the app actually sends. Written from the request verbatim so that if the
 * meaning of an operator ever drifts, the failure names which question stopped
 * being answerable.
 */
describe('the territory queries', () => {
  it('sells only in Canada', () => {
    expect(
      conditionToPredicate({ field: 'sells_in', operator: 'is_exactly', value: ['CA'] }),
    ).toEqual({ expression: 'sells_in.eq.{"CA"}' })
  })

  it('sells in Canada and the USA, whatever else', () => {
    expect(
      conditionToPredicate({ field: 'sells_in', operator: 'has_all', value: ['CA', 'US'] }),
    ).toEqual({ expression: 'sells_in.cs.{"CA","US"}' })
  })

  it('sells in the USA and also Mexico', () => {
    expect(
      conditionToPredicate({ field: 'sells_in', operator: 'has_all', value: ['US', 'MX'] }),
    ).toEqual({ expression: 'sells_in.cs.{"US","MX"}' })
  })

  it('sells in either, rather than both', () => {
    expect(
      conditionToPredicate({ field: 'sells_in', operator: 'has_any', value: ['US', 'MX'] }),
    ).toEqual({ expression: 'sells_in.ov.{"US","MX"}' })
  })

  it('sells in neither', () => {
    expect(
      conditionToPredicate({ field: 'sells_in', operator: 'has_none', value: ['US', 'MX'] }),
    ).toEqual({ expression: 'sells_in.not.ov.{"US","MX"}' })
  })
})

describe('set operators generally', () => {
  it('takes a comma-separated string as readily as an array', () => {
    expect(
      conditionToPredicate({ field: 'sells_in', operator: 'has_all', value: 'CA, US' }),
    ).toEqual({ expression: 'sells_in.cs.{"CA","US"}' })
  })

  it('is not a filter at all when the list is empty', () => {
    // Half-typed input must not become "matches everything" or "matches
    // nothing" — either would quietly show the wrong answer.
    for (const operator of ['has_all', 'has_any', 'has_none', 'is_exactly'] as FilterOperator[]) {
      expect(conditionToPredicate({ field: 'sells_in', operator, value: [] })).toBeNull()
      expect(conditionToPredicate({ field: 'sells_in', operator, value: '' })).toBeNull()
      expect(conditionToPredicate({ field: 'sells_in', operator, value: ' , ' })).toBeNull()
    }
  })

  it('quotes every value, so a name with a comma cannot split the list', () => {
    expect(
      conditionToPredicate({
        field: 'stock_type',
        operator: 'has_all',
        value: ['Customer returns'],
      }),
    ).toEqual({ expression: 'stock_type.cs.{"Customer returns"}' })
  })

  it('offers the four set operations on an array field and nothing numeric', () => {
    const operators = operatorsFor('array')
    expect(operators).toContain('has_all')
    expect(operators).toContain('has_any')
    expect(operators).toContain('has_none')
    expect(operators).toContain('is_exactly')
    expect(operators).not.toContain('gt')
    expect(operators).not.toContain('starts_with')
  })

  it('gives every operator a label, including the new ones', () => {
    for (const operator of operatorsFor('array')) {
      expect(OPERATOR_LABELS[operator]).toBeTruthy()
    }
  })
})
