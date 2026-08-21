import { describe, expect, it } from 'vitest'

import { headerPatch, headerSchema } from '@/lib/sales-order-header'

/**
 * The header is posted by five separate cards, and each one must save its own
 * fields and touch nothing else.
 *
 * These are regression tests for a real failure: `order_date` was required by
 * the schema while only the Sales Order Detail card carried it, so the
 * Customer & Shipping, Notes and Shipping cards all parsed as a missing
 * required string, returned "Required" in red, and wrote nothing at all. Four
 * cards, silently unsaveable.
 */

/** One card's submission: the keys that card actually renders. */
function post(fields: Record<string, string>): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return form
}

function patchFor(fields: Record<string, string>) {
  const parsed = headerSchema.safeParse(Object.fromEntries(post(fields)))
  if (!parsed.success) {
    throw new Error(`did not parse: ${parsed.error.issues[0]?.message}`)
  }
  return headerPatch(parsed.data, post(fields))
}

describe('a card that does not carry the order date', () => {
  it('parses — the Notes card', () => {
    const parsed = headerSchema.safeParse({ notes: 'Printers cancelled' })
    expect(parsed.success).toBe(true)
  })

  it('parses — the Shipping card', () => {
    const parsed = headerSchema.safeParse({
      shipping_method: 'LTL',
      shipping_responsibility: 'Buyer',
    })
    expect(parsed.success).toBe(true)
  })

  it('parses — the Customer & Shipping card', () => {
    const parsed = headerSchema.safeParse({
      company_id: 'c1',
      contact_id: 'p1',
      shipping_address: '12 Dock Road',
    })
    expect(parsed.success).toBe(true)
  })

  it('saves what it carries', () => {
    expect(patchFor({ notes: 'Printers cancelled' })).toEqual({ notes: 'Printers cancelled' })
    expect(patchFor({ shipping_address: '12 Dock Road' })).toEqual({
      shipping_address: '12 Dock Road',
    })
    expect(patchFor({ shipping_method: 'LTL' })).toEqual({ shipping_method: 'LTL' })
  })
})

describe('the card that does carry it', () => {
  it('still refuses a date somebody emptied', () => {
    const parsed = headerSchema.safeParse({ order_date: '   ' })
    expect(parsed.success).toBe(false)
  })

  it('saves the date it was given', () => {
    expect(patchFor({ order_date: '2026-05-15' })).toEqual({ order_date: '2026-05-15' })
  })
})

describe('a save touches only its own card', () => {
  it('leaves every field the form never asked about alone', () => {
    const patch = patchFor({ notes: 'Just the notes' })
    expect(Object.keys(patch)).toEqual(['notes'])
    // The ones a naive patch would have wiped.
    for (const key of ['shipping_method', 'shipping_address', 'company_id', 'order_date']) {
      expect(patch).not.toHaveProperty(key)
    }
  })

  it('reads a cleared field as a clearing', () => {
    // Present but empty means somebody emptied it, and these columns are
    // nullable — so the patch must carry null rather than ''.
    expect(patchFor({ notes: '' })).toEqual({ notes: null })
    expect(patchFor({ shipping_method: '' })).toEqual({ shipping_method: null })
  })

  it('ignores a currency the picker disabled', () => {
    // Rendered as text rather than a select once the order leaves draft, so
    // the browser posts nothing — and nothing must not become a currency.
    expect(patchFor({ currency: '' })).toEqual({})
    expect(patchFor({ currency: 'USD' })).toEqual({ currency: 'USD' })
  })
})

describe('the checkbox pairs', () => {
  it('reads hidden-false-then-checked as true', () => {
    const form = new FormData()
    form.append('show_discount', 'false')
    form.append('show_discount', 'true')
    const parsed = headerSchema.parse(Object.fromEntries(form))
    expect(parsed.show_discount).toBe(true)
  })

  it('reads the hidden false alone as false', () => {
    expect(patchFor({ show_discount: 'false' })).toEqual({ show_discount: false })
  })

  it('no longer carries deposit_required at all', () => {
    // The checkbox is gone. The column keeps whatever it held, which means no
    // save may write it — not even to false.
    expect(patchFor({ deposit_required: 'true' })).toEqual({})
  })
})
