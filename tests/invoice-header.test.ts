import { describe, expect, it } from 'vitest'

import { headerPatch, headerSchema } from '@/lib/invoice-header'

/**
 * The invoice header is now posted by two cards — Invoice Detail and Notes —
 * and each must save its own fields and touch nothing else.
 *
 * Written before the split rather than after it, because the sales order
 * learned this the expensive way: its header was spread across five cards
 * while the schema still insisted on a field only one of them carried, and
 * four cards went silently unsaveable. Everything here is the shape of that
 * failure, asked of the invoice.
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

describe('a card that does not carry every field', () => {
  it('parses — the Notes card', () => {
    expect(headerSchema.safeParse({ notes: 'Collected in person' }).success).toBe(true)
  })

  it('parses — the Invoice Detail card of a sent invoice', () => {
    // No issue_date and no currency: both are shown rather than offered once
    // the document has left draft.
    expect(
      headerSchema.safeParse({
        payment_terms: 'Net 30',
        due_date: '2026-09-20',
        show_discount: 'false',
      }).success,
    ).toBe(true)
  })
})

describe('one card does not answer for another', () => {
  it('saving the notes leaves the payment terms alone', () => {
    const patch = patchFor({ notes: 'Collected in person' })
    expect(patch).toEqual({ notes: 'Collected in person' })
    expect(patch).not.toHaveProperty('payment_terms')
    expect(patch).not.toHaveProperty('due_date')
    expect(patch).not.toHaveProperty('show_discount')
  })

  it('saving the detail leaves the notes alone', () => {
    const patch = patchFor({
      issue_date: '2026-08-22',
      payment_terms: 'Net 30',
      due_date: '2026-09-21',
      show_discount: 'true',
    })
    expect(patch).not.toHaveProperty('notes')
    expect(patch.payment_terms).toBe('Net 30')
    expect(patch.issue_date).toBe('2026-08-22')
    expect(patch.due_date).toBe('2026-09-21')
    expect(patch.show_discount).toBe(true)
  })
})

describe('cleared means cleared', () => {
  it('a payment terms box emptied on purpose reaches null', () => {
    expect(patchFor({ payment_terms: '' })).toEqual({ payment_terms: null })
  })

  it('a due date cleared on purpose reaches null', () => {
    expect(patchFor({ due_date: '' })).toEqual({ due_date: null })
  })

  it('emptied notes reach null rather than an empty string', () => {
    expect(patchFor({ notes: '' })).toEqual({ notes: null })
  })

  /*
   * Not trimmed, deliberately: a note is free text where leading blank lines
   * can be somebody's layout, and the sales order's notes behave the same way.
   * Pinned so the two cannot drift apart quietly.
   */
  it('keeps whitespace somebody typed on purpose', () => {
    expect(patchFor({ notes: '  ' })).toEqual({ notes: '  ' })
  })
})

describe('the currency picker', () => {
  it('is written when the card offered it', () => {
    expect(patchFor({ currency: 'EUR' }).currency).toBe('EUR')
  })

  /*
   * A sent or part-paid invoice prints its currency instead of offering it, so
   * the browser sends no key at all. A default here would write that default
   * over the invoice's real currency on every unrelated save.
   */
  it('is untouched when the card only printed it', () => {
    expect(patchFor({ payment_terms: 'Net 30' })).not.toHaveProperty('currency')
  })

  it('is untouched when something posts a currency it does not recognise', () => {
    expect(patchFor({ currency: 'ZZZ' })).not.toHaveProperty('currency')
  })
})

describe('sold through', () => {
  it('blank means direct, which is a real answer', () => {
    expect(patchFor({ marketplace_id: '' })).toEqual({ marketplace_id: null })
  })

  it('a chosen channel is written', () => {
    expect(patchFor({ marketplace_id: 'abc-123' })).toEqual({ marketplace_id: 'abc-123' })
  })

  it('is untouched by an invoice raised from an order, which only prints it', () => {
    expect(patchFor({ payment_terms: 'Net 30' })).not.toHaveProperty('marketplace_id')
  })
})

describe('the invoice date', () => {
  it('is written when the card offered it', () => {
    expect(patchFor({ issue_date: '2026-08-22' }).issue_date).toBe('2026-08-22')
  })

  /* An invoice has to have one, so a card that asks and gets nothing is wrong. */
  it('cannot be cleared by the card that owns it', () => {
    expect(headerSchema.safeParse({ issue_date: '' }).success).toBe(false)
  })

  it('is untouched by a card that never asked', () => {
    expect(patchFor({ notes: 'x' })).not.toHaveProperty('issue_date')
  })
})

describe('the show discount checkbox', () => {
  /* Hidden false, then the checkbox: the last value of a repeated name wins. */
  it('reads true when it is ticked', () => {
    const form = new FormData()
    form.set('id', 'x')
    form.append('show_discount', 'false')
    form.append('show_discount', 'true')
    const parsed = headerSchema.safeParse(Object.fromEntries(form))
    expect(parsed.success && parsed.data.show_discount).toBe(true)
  })

  it('reads false when it is clear', () => {
    expect(patchFor({ show_discount: 'false' })).toEqual({ show_discount: false })
  })
})

describe('a form with nothing on it', () => {
  it('produces no patch at all, rather than a row of defaults', () => {
    expect(patchFor({})).toEqual({})
  })
})
