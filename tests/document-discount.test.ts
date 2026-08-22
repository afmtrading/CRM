import { describe, expect, it } from 'vitest'

import { documentDiscount, documentRevisionLabel, documentTotals } from '@/lib/sales'
import { headerPatch, headerSchema } from '@/lib/sales-order-header'

/**
 * Money off a whole document, rather than off a line.
 *
 * The formula has a twin in SQL — `document_discount` — and the invoice's
 * stored total is computed there, so these tests and 19_sales_orders.sql are
 * asserting the same arithmetic from two sides. Where they could drift is
 * exactly where an invoice would say it is paid when it is not.
 */

const lines = (...totals: number[]) => totals.map((line_total) => ({ line_total }))

describe('documentDiscount', () => {
  it('takes a percentage off the subtotal', () => {
    expect(documentDiscount(200, 'percent', 5)).toBe(10)
  })

  it('takes an amount off flat', () => {
    expect(documentDiscount(200, 'fixed', 25)).toBe(25)
  })

  it('is nothing when there is no discount', () => {
    expect(documentDiscount(200, null, null)).toBe(0)
    expect(documentDiscount(200, 'percent', null)).toBe(0)
    expect(documentDiscount(200, null, 5)).toBe(0)
  })

  /*
   * Both clamps, and both for the reason a line's discount gives: a discount
   * is money off. It is never a surcharge, and it never turns into money owed
   * back to the customer.
   */
  it('never exceeds the subtotal', () => {
    expect(documentDiscount(200, 'fixed', 500)).toBe(200)
    expect(documentDiscount(200, 'percent', 150)).toBe(200)
  })

  it('never goes below zero', () => {
    expect(documentDiscount(200, 'fixed', -50)).toBe(0)
    expect(documentDiscount(0, 'percent', 10)).toBe(0)
  })

  it('rounds to the cent', () => {
    expect(documentDiscount(10.01, 'percent', 33.33)).toBe(3.34)
  })
})

describe('documentTotals with a discount', () => {
  it('takes it off the subtotal, before shipping', () => {
    // Carriage is what it costs to send the goods. A discount on the goods
    // does not make the truck cheaper.
    const totals = documentTotals(lines(100, 100), 20, 0, { rateType: 'percent', rate: 10 })
    expect(totals.subtotal).toBe(200)
    expect(totals.discount).toBe(20)
    expect(totals.shipping).toBe(20)
    expect(totals.total).toBe(200)
  })

  it('leaves the balance owing what the discount left', () => {
    const totals = documentTotals(lines(500), 0, 100, { rateType: 'fixed', rate: 50 })
    expect(totals.total).toBe(450)
    expect(totals.balance).toBe(350)
  })

  it('is the old arithmetic when nothing is discounted', () => {
    const totals = documentTotals(lines(10, 20), 5, 3)
    expect(totals).toEqual({
      subtotal: 30,
      discount: 0,
      shipping: 5,
      total: 35,
      paid: 3,
      balance: 32,
    })
  })

  it('a discount larger than the order makes it free rather than negative', () => {
    const totals = documentTotals(lines(40), 10, 0, { rateType: 'fixed', rate: 100 })
    expect(totals.discount).toBe(40)
    expect(totals.total).toBe(10)
  })
})

describe('documentRevisionLabel', () => {
  it('reads the way a line revision does', () => {
    expect(documentRevisionLabel('percent', 5, 'USD')).toBe('5% off')
    expect(documentRevisionLabel('fixed', 25, 'USD')).toBe('$25.00 off')
  })

  it('says nothing when there is no discount', () => {
    expect(documentRevisionLabel(null, null, 'USD')).toBeNull()
    expect(documentRevisionLabel('percent', null, 'USD')).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */

function patchFor(fields: Record<string, string>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  const parsed = headerSchema.safeParse(Object.fromEntries(form))
  if (!parsed.success) throw new Error(`did not parse: ${parsed.error.issues[0]?.message}`)
  return headerPatch(parsed.data, form)
}

/**
 * The pair, on the way to a table whose CHECK refuses half of one.
 *
 * `(discount_type is null) = (discount_rate is null)`. Every case below is a
 * form that could otherwise put a database error in front of somebody who
 * cleared a box.
 */
describe('the discount pair on a save', () => {
  it('writes both when both are given', () => {
    expect(patchFor({ discount_rate: '5', discount_type: 'percent' })).toEqual({
      discount_rate: 5,
      discount_type: 'percent',
    })
  })

  it('a rate with no kind chosen is a percentage', () => {
    expect(patchFor({ discount_rate: '5' })).toEqual({
      discount_rate: 5,
      discount_type: 'percent',
    })
  })

  it('clearing the rate clears the kind with it', () => {
    expect(patchFor({ discount_rate: '', discount_type: 'fixed' })).toEqual({
      discount_rate: null,
      discount_type: null,
    })
  })

  it('a kind on its own writes nothing at all', () => {
    expect(patchFor({ discount_type: 'fixed' })).toEqual({
      discount_rate: null,
      discount_type: null,
    })
  })

  it('a negative rate is refused rather than stored', () => {
    expect(patchFor({ discount_rate: '-5' })).toEqual({
      discount_rate: null,
      discount_type: null,
    })
  })

  /* A card that does not ask about the discount must not clear one. */
  it('is untouched by a card that never asked', () => {
    const patch = patchFor({ notes: 'Delivered Friday' })
    expect(patch).not.toHaveProperty('discount_rate')
    expect(patch).not.toHaveProperty('discount_type')
  })
})

describe('the shipping charge, which had no field at all', () => {
  it('is written by the card that now asks for it', () => {
    expect(patchFor({ shipping_charge: '125.50' })).toEqual({ shipping_charge: 125.5 })
  })

  it('is untouched by a card that never asked', () => {
    expect(patchFor({ notes: 'x' })).not.toHaveProperty('shipping_charge')
  })
})
