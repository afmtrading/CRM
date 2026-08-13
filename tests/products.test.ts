import { describe, expect, it } from 'vitest'

import {
  PRODUCT_CONDITIONS,
  PRODUCT_STATUSES,
  PRODUCT_TYPES,
  SHOWROOM_SHARE,
  WHOLESALE_SHARE,
  derivePricing,
  productStatusLabel,
  toNumber,
  unitMargin,
} from '../src/lib/products'

/*
 * The whole point of these columns being nullable is that null means "work it
 * out" rather than "zero". Every test here is really the same test: does the
 * price list still say something sensible when nobody typed a number into it.
 */

describe('toNumber', () => {
  it('reads what Postgres sends back', () => {
    // numeric(14,2) arrives over PostgREST as a string, every time.
    expect(toNumber('12.50')).toBe(12.5)
    expect(toNumber(12.5)).toBe(12.5)
  })

  it('treats an empty box as nothing, not as zero', () => {
    expect(toNumber('')).toBeNull()
    expect(toNumber('   ')).toBeNull()
    expect(toNumber(null)).toBeNull()
    expect(toNumber(undefined)).toBeNull()
  })

  it('refuses what is not a number', () => {
    expect(toNumber('twelve')).toBeNull()
    expect(toNumber(Number.NaN)).toBeNull()
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('derivePricing — unit prices', () => {
  it('works showroom and wholesale out from retail', () => {
    const pricing = derivePricing({ unit_price: 100 })

    expect(pricing.unit.retail.value).toBe(100)
    expect(pricing.unit.showroom.value).toBe(100 * SHOWROOM_SHARE)
    expect(pricing.unit.wholesale.value).toBe(100 * WHOLESALE_SHARE)
    expect(pricing.unit.showroom.auto).toBe(true)
    expect(pricing.unit.wholesale.auto).toBe(true)
  })

  it('rounds to the cent rather than to whatever floating point produces', () => {
    // 19.99 * 0.7 is 13.992999999999999 in IEEE 754.
    expect(derivePricing({ unit_price: 19.99 }).unit.showroom.value).toBe(13.99)
    expect(derivePricing({ unit_price: 19.99 }).unit.wholesale.value).toBe(6)
  })

  it('lets a typed price win, and says that it was typed', () => {
    const pricing = derivePricing({ unit_price: 100, price_showroom: 82 })

    expect(pricing.unit.showroom.value).toBe(82)
    expect(pricing.unit.showroom.auto).toBe(false)
    // The other one is untouched by the override.
    expect(pricing.unit.wholesale.value).toBe(30)
    expect(pricing.unit.wholesale.auto).toBe(true)
  })

  it('honours a deliberate zero', () => {
    // A giveaway is a real price. If an override of 0 fell through to the rule
    // the product would quietly go back to costing 70% of retail.
    const pricing = derivePricing({ unit_price: 100, price_showroom: 0 })
    expect(pricing.unit.showroom.value).toBe(0)
    expect(pricing.unit.showroom.auto).toBe(false)
  })
})

describe('derivePricing — piece prices', () => {
  it('divides the unit price by the case pack', () => {
    const pricing = derivePricing({ unit_price: 120, case_pack: 12 })

    expect(pricing.piece.retail.value).toBe(10)
    expect(pricing.piece.showroom.value).toBe(7)
    expect(pricing.piece.wholesale.value).toBe(3)
    expect(pricing.piece.retail.auto).toBe(true)
  })

  it('follows an overridden unit price rather than going back to retail', () => {
    // Somebody who sets a showroom price by hand means it to be the showroom
    // price at every quantity, so the piece price divides 82 and not 70.
    const pricing = derivePricing({ unit_price: 100, price_showroom: 82, case_pack: 2 })

    expect(pricing.piece.showroom.value).toBe(41)
    expect(pricing.piece.retail.value).toBe(50)
  })

  it('has nothing to say without a case pack', () => {
    const pricing = derivePricing({ unit_price: 120 })

    expect(pricing.piece.retail.value).toBeNull()
    expect(pricing.piece.showroom.value).toBeNull()
    expect(pricing.casePack).toBeNull()
  })

  it('refuses to divide by zero or by a negative case pack', () => {
    expect(derivePricing({ unit_price: 120, case_pack: 0 }).piece.retail.value).toBeNull()
    expect(derivePricing({ unit_price: 120, case_pack: -4 }).piece.retail.value).toBeNull()
  })

  it('lets a typed piece price stand on its own', () => {
    // No case pack, so there is no rule — but a number somebody typed is still
    // a number, and dropping it would lose data.
    const pricing = derivePricing({ unit_price: 120, piece_price_retail: 9.5 })

    expect(pricing.piece.retail.value).toBe(9.5)
    expect(pricing.piece.retail.auto).toBe(false)
  })
})

describe('derivePricing — pallets and costs', () => {
  it('invents nothing for a pallet', () => {
    const pricing = derivePricing({ unit_price: 100, case_pack: 10 })

    expect(pricing.pallet.retail.value).toBeNull()
    expect(pricing.pallet.wholesale.value).toBeNull()
    expect(pricing.pallet.cost.value).toBeNull()
  })

  it('keeps the costs that were entered and leaves the rest empty', () => {
    const pricing = derivePricing({ unit_cost: 40, piece_cost: 3.5, case_pack: 10 })

    expect(pricing.unit.cost.value).toBe(40)
    expect(pricing.piece.cost.value).toBe(3.5)
    // Cost is never derived: a case pack tells you how to split a price, not
    // how a supplier chose to bill you.
    expect(pricing.pallet.cost.value).toBeNull()
  })

  it('reads a whole row of strings the way it reads numbers', () => {
    const fromDatabase = derivePricing({
      unit_price: '100.00',
      unit_cost: '55.00',
      price_showroom: null,
      case_pack: '4',
    })

    expect(fromDatabase.unit.retail.value).toBe(100)
    expect(fromDatabase.unit.showroom.value).toBe(70)
    expect(fromDatabase.piece.retail.value).toBe(25)
  })
})

describe('unitMargin', () => {
  it('is the difference and the share of retail it represents', () => {
    expect(unitMargin({ unit_price: 100, unit_cost: 60 })).toEqual({ amount: 40, percent: 40 })
  })

  it('goes negative rather than pretending', () => {
    expect(unitMargin({ unit_price: 50, unit_cost: 80 }).amount).toBe(-30)
  })

  it('has no percentage to give when nothing is charged', () => {
    // Dividing by a retail price of zero would produce Infinity and render as
    // "∞%" on the record.
    expect(unitMargin({ unit_price: 0, unit_cost: 10 }).percent).toBeNull()
  })
})

describe('the closed vocabularies', () => {
  it('offers exactly the values the check constraints allow', () => {
    expect(PRODUCT_TYPES.map((t) => t.value)).toEqual(['item', 'case', 'pallet', 'kit', 'bin'])
    expect(PRODUCT_CONDITIONS.map((c) => c.value)).toEqual([
      'new',
      'open_box',
      'damaged',
      'refurbished',
      'expired',
    ])
    expect(PRODUCT_STATUSES.map((s) => s.value)).toEqual([
      'active',
      'inactive',
      'discontinued',
      'quarantined',
      'sold',
    ])
  })

  it('names a status even when a row somehow carries none', () => {
    expect(productStatusLabel('quarantined')).toBe('Quarantined')
    expect(productStatusLabel(null)).toBe('Active')
  })
})
