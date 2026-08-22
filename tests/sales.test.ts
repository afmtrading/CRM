import { describe, expect, it } from 'vitest'

import {
  EMPTY_SALES_ORDER_FILTER,
  INVOICE_STATUS_LABELS,
  SALES_ORDER_STATUSES,
  SALES_ORDER_STATUS_HINTS,
  SALES_ORDER_STATUS_LABELS,
  canInvoice,
  canTransition,
  daysOverdue,
  documentMargin,
  documentTotals,
  invoiceBlockedReason,
  invoiceStatusFor,
  isEditable,
  isOverdue,
  isSalesOrderFiltered,
  ledgerBalance,
  lineDiscount,
  lineName,
  lineTotal,
  nextStatuses,
  previewInvoiceLine,
  renumber,
  revisedUnitPrice,
  revisionLabel,
  round2,
  salesOrderFilterFromParams,
  salesOrderFilterToParams,
  settableInvoiceStatuses,
  summariseInvoices,
  totalsByCurrency,
} from '../src/lib/sales'
import type { InvoiceRow, SalesOrderLineRow } from '../src/lib/database.types'

function invoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 'i1',
    organization_id: 'o1',
    number: 'INV-0001',
    sales_order_id: null,
    marketplace_id: null,
    company_id: 'c1',
    contact_id: null,
    owner_id: 'u1',
    owner_name: 'Raj',
    status: 'sent',
    currency: 'USD',
    discount_type: null,
    discount_rate: null,
    issue_date: '2026-01-10',
    due_date: null,
    subtotal: 1000,
    shipping_charge: 0,
    total: 1000,
    amount_paid: 0,
    payment_terms: null,
    notes: null,
    terms: null,
    show_discount: true,
    created_by: null,
    created_at: '2026-01-10T00:00:00Z',
    updated_at: '2026-01-10T00:00:00Z',
    ...overrides,
  }
}

function line(overrides: Partial<SalesOrderLineRow> = {}): SalesOrderLineRow {
  return {
    id: 'l1',
    organization_id: 'o1',
    sales_order_id: 's1',
    product_id: 'p1',
    description: null,
    notes: null,
    unit: null,
    quantity: 10,
    unit_price: 100,
    unit_cost: 60,
    revised_rate_type: null,
    revised_rate: null,
    discount: 0,
    line_total: 1000,
    line_cost: 600,
    position: 0,
    created_at: '2026-01-10T00:00:00Z',
    updated_at: '2026-01-10T00:00:00Z',
    ...overrides,
  }
}

describe('rounding', () => {
  it('rounds to cents', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(2.675)).toBe(2.68)
  })

  /*
   * The reason this function exists at all. Without it a line of 0.1 + 0.2
   * reaches an invoice as 0.30000000000000004.
   */
  it('does not let float drift onto a document', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(lineTotal(3, 0.1, null, null)).toBe(0.3)
  })
})

describe('a revised rate', () => {
  it('leaves the list price alone when there is none', () => {
    expect(revisedUnitPrice(100, null, null)).toBe(100)
    expect(lineDiscount(10, 100, null, null)).toBe(0)
    expect(lineTotal(10, 100, null, null)).toBe(1000)
  })

  it('takes a percentage off', () => {
    expect(revisedUnitPrice(100, 'percent', 10)).toBe(90)
    expect(lineDiscount(10, 100, 'percent', 10)).toBe(100)
    expect(lineTotal(10, 100, 'percent', 10)).toBe(900)
  })

  /*
   * A fixed rate is money off a unit, the same kind of thing a percentage is.
   * It used to replace the unit price outright, which read as "$1 means the
   * unit is now $1" under a column labelled Discount — see 20260268000000.
   */
  it('takes a fixed amount off each unit', () => {
    expect(revisedUnitPrice(100, 'fixed', 80)).toBe(20)
    expect(lineDiscount(10, 100, 'fixed', 80)).toBe(800)
    expect(lineTotal(10, 100, 'fixed', 80)).toBe(200)
  })

  /** The line off the desk's own order: 2 at $6, a dollar off each. */
  it('the case that prompted the change', () => {
    expect(revisedUnitPrice(6, 'fixed', 1)).toBe(5)
    expect(lineTotal(2, 6, 'fixed', 1)).toBe(10)
  })

  /*
   * More off than the unit is worth. Free, and no further: reading the excess
   * as money owed back would turn a mistyped discount into a refund.
   */
  it('stops at free when the discount exceeds the price', () => {
    expect(revisedUnitPrice(100, 'fixed', 120)).toBe(0)
    expect(lineDiscount(10, 100, 'fixed', 120)).toBe(1000)
    expect(lineTotal(10, 100, 'fixed', 120)).toBe(0)
  })

  it('stops at free rather than paying the customer', () => {
    expect(revisedUnitPrice(100, 'percent', 150)).toBe(0)
    expect(lineDiscount(10, 100, 'percent', 150)).toBe(1000)
    expect(lineTotal(10, 100, 'percent', 150)).toBe(0)
  })

  it('handles the boundary exactly', () => {
    expect(lineTotal(10, 100, 'percent', 100)).toBe(0)
    expect(lineTotal(10, 100, 'percent', 0)).toBe(1000)
    // Nothing off is the list price, where it used to mean "the unit is now 0".
    expect(lineTotal(10, 100, 'fixed', 0)).toBe(1000)
  })

  /* A half of a pair is a line nobody can price; the database refuses it, and
   * this side treats it as no revision rather than guessing. */
  it('ignores a rate with no type and a type with no rate', () => {
    expect(lineDiscount(10, 100, null, 10)).toBe(0)
    expect(lineDiscount(10, 100, 'percent', null)).toBe(0)
  })

  it('says how a revision reads', () => {
    expect(revisionLabel('percent', 10, 'USD')).toBe('10% off')
    expect(revisionLabel('fixed', 80, 'USD')).toBe('$80.00 off')
    expect(revisionLabel(null, null, 'USD')).toBeNull()
  })
})

describe('document totals', () => {
  it('adds the lines and then the shipping', () => {
    const totals = documentTotals([{ line_total: 1000 }, { line_total: 50 }], 25)
    expect(totals.subtotal).toBe(1050)
    expect(totals.shipping).toBe(25)
    expect(totals.total).toBe(1075)
  })

  it('is zero for a document with nothing on it', () => {
    expect(documentTotals([]).total).toBe(0)
  })

  it('reports what is still owed', () => {
    const totals = documentTotals([{ line_total: 1000 }], 0, 300)
    expect(totals.paid).toBe(300)
    expect(totals.balance).toBe(700)
  })

  // Worth seeing rather than clamping: an overpayment is a refund to arrange.
  it('shows an overpayment as a negative balance', () => {
    expect(documentTotals([{ line_total: 100 }], 0, 150).balance).toBe(-50)
  })

  it('nets a payment ledger, reversals included', () => {
    expect(ledgerBalance([{ amount: 500 }, { amount: -200 }, { amount: 100 }])).toBe(400)
    expect(ledgerBalance([])).toBe(0)
  })
})

describe('margin', () => {
  it('is revenue less cost when the lines carry one', () => {
    expect(documentMargin([{ line_total: 1000, line_cost: 600 }])).toBe(400)
  })

  /*
   * The deal ledger's rule, applied to documents: zero reads as "we made
   * nothing", and not knowing is a different statement.
   */
  it('is unknown rather than zero when nothing has a cost', () => {
    expect(documentMargin([{ line_total: 1000, line_cost: 0 }])).toBeNull()
    expect(documentMargin([])).toBeNull()
  })

  it('is reported once any line carries a cost, over all the lines', () => {
    expect(
      documentMargin([
        { line_total: 1000, line_cost: 600 },
        { line_total: 500, line_cost: 0 },
      ]),
    ).toBe(900)
  })
})

describe('a sales order status', () => {
  it('has a label and an explanation for every one of them', () => {
    for (const status of SALES_ORDER_STATUSES) {
      expect(SALES_ORDER_STATUS_LABELS[status]).toBeTruthy()
      expect(SALES_ORDER_STATUS_HINTS[status]).toBeTruthy()
    }
  })

  it('moves forward or to cancelled', () => {
    expect(nextStatuses('draft')).toEqual(['reserved', 'confirmed', 'cancelled'])
    expect(nextStatuses('reserved')).toEqual(['confirmed', 'cancelled'])
    // Invoiced is not offered from anywhere: raising the invoice sets it, and
    // 20260270000000 refuses it otherwise. See the block below.
    expect(nextStatuses('confirmed')).toEqual(['cancelled'])
  })

  /*
   * A signed order cannot become a draft again. The deposit on it is a fact,
   * and a status that walks backwards makes every report over it a question of
   * when you happened to look.
   */
  it('never goes back', () => {
    expect(canTransition('reserved', 'draft')).toBe(false)
    expect(canTransition('confirmed', 'reserved')).toBe(false)
    expect(canTransition('fulfilled', 'confirmed')).toBe(false)
  })

  it('ends at fulfilled and at cancelled', () => {
    expect(nextStatuses('fulfilled')).toEqual([])
    expect(nextStatuses('cancelled')).toEqual([])
  })

  it('cannot be its own next step', () => {
    for (const status of SALES_ORDER_STATUSES) {
      expect(canTransition(status, status)).toBe(false)
    }
  })

  it('allows only what it lists', () => {
    for (const from of SALES_ORDER_STATUSES) {
      for (const to of SALES_ORDER_STATUSES) {
        expect(canTransition(from, to)).toBe(nextStatuses(from).includes(to))
      }
    }
  })
})

describe('invoicing an order', () => {
  it('needs a confirmed order', () => {
    expect(canInvoice('confirmed')).toBe(true)
    expect(canInvoice('fulfilled')).toBe(true)
    expect(canInvoice('draft')).toBe(false)
    expect(canInvoice('reserved')).toBe(false)
    expect(canInvoice('cancelled')).toBe(false)
  })

  it('says why not, in words somebody can act on', () => {
    expect(invoiceBlockedReason('confirmed')).toBeNull()
    expect(invoiceBlockedReason('draft')).toBe('Confirm the order before invoicing it.')
    expect(invoiceBlockedReason('cancelled')).toBe('A cancelled order cannot be invoiced.')
  })

  it('stops the lines being edited once the order is finished with', () => {
    expect(isEditable('draft')).toBe(true)
    expect(isEditable('confirmed')).toBe(true)
    expect(isEditable('fulfilled')).toBe(false)
    expect(isEditable('cancelled')).toBe(false)
  })
})

describe('an invoice status', () => {
  it('has a label for every one of them', () => {
    for (const status of ['draft', 'sent', 'partial', 'paid', 'void'] as const) {
      expect(INVOICE_STATUS_LABELS[status]).toBeTruthy()
    }
  })

  it('follows the money', () => {
    expect(invoiceStatusFor(1000, 0, 'draft')).toBe('draft')
    expect(invoiceStatusFor(1000, 400, 'draft')).toBe('partial')
    expect(invoiceStatusFor(1000, 1000, 'draft')).toBe('paid')
  })

  it('counts an overpayment as paid', () => {
    expect(invoiceStatusFor(1000, 1200, 'sent')).toBe('paid')
  })

  it('keeps "sent" while nothing has been paid', () => {
    expect(invoiceStatusFor(1000, 0, 'sent')).toBe('sent')
  })

  // Paid and partial are facts about money. "Sent" is a flag somebody set.
  it('lets the money outrank the flag', () => {
    expect(invoiceStatusFor(1000, 400, 'sent')).toBe('partial')
  })

  /*
   * Sticky on purpose. A voided invoice that later receives a payment is still
   * void, and somebody has some explaining to do — which they cannot do if the
   * document quietly un-voided itself.
   */
  it('stays void whatever happens afterwards', () => {
    expect(invoiceStatusFor(1000, 0, 'void')).toBe('void')
    expect(invoiceStatusFor(1000, 1000, 'void')).toBe('void')
  })

  it('reverses back down when a payment is reversed', () => {
    expect(invoiceStatusFor(1000, 0, 'paid')).toBe('draft')
    expect(invoiceStatusFor(1000, 500, 'paid')).toBe('partial')
  })

  /*
   * The rule the whole ledger exists to enforce: paid and partial are never
   * offered, because offering them would let somebody mark an invoice paid
   * with no money behind it.
   */
  it('offers only the statuses a person may set by hand', () => {
    expect(settableInvoiceStatuses('draft')).toEqual(['sent', 'void'])
    expect(settableInvoiceStatuses('sent')).toEqual(['void'])
    expect(settableInvoiceStatuses('partial')).not.toContain('paid')
    expect(settableInvoiceStatuses('void')).toEqual([])
  })
})

describe('overdue', () => {
  it('is money still owed past the date', () => {
    expect(isOverdue(invoice({ due_date: '2026-01-01', status: 'sent' }), '2026-02-01')).toBe(true)
  })

  it('is not overdue on the day it falls due', () => {
    expect(isOverdue(invoice({ due_date: '2026-02-01', status: 'sent' }), '2026-02-01')).toBe(false)
  })

  it('cannot be overdue with nothing owed', () => {
    expect(isOverdue(invoice({ due_date: '2026-01-01', status: 'paid' }), '2026-02-01')).toBe(false)
    expect(isOverdue(invoice({ due_date: '2026-01-01', status: 'void' }), '2026-02-01')).toBe(false)
  })

  // An invoice with no date agreed cannot be late against one.
  it('is never overdue without a due date', () => {
    expect(isOverdue(invoice({ due_date: null, status: 'sent' }), '2026-02-01')).toBe(false)
  })

  it('counts the days', () => {
    expect(daysOverdue('2026-01-25', '2026-02-01')).toBe(7)
    expect(daysOverdue('2026-02-01', '2026-02-01')).toBe(0)
    expect(daysOverdue(null, '2026-02-01')).toBe(0)
  })

  /* Days are compared as calendar dates, so a timezone cannot make an invoice
   * late a few hours early. */
  it('does not drift across a month boundary', () => {
    expect(daysOverdue('2026-02-28', '2026-03-01')).toBe(1)
  })
})

describe('naming a line', () => {
  it('prefers the product', () => {
    expect(lineName(line({ description: 'Ad hoc' }), 'Speaker')).toBe('Speaker')
  })

  it('falls back to the description the line carries itself', () => {
    expect(lineName(line({ product_id: null, description: 'Freight' }), null)).toBe('Freight')
  })

  it('never renders an empty cell', () => {
    expect(lineName(line({ product_id: null, description: null }), null)).toBe('Item')
    expect(lineName(line({ description: '  ' }), '  ')).toBe('Item')
  })
})

describe('positions', () => {
  it('renumbers from zero, closing any gaps', () => {
    const renumbered = renumber([{ position: 7 }, { position: 7 }, { position: 2 }])
    expect(renumbered.map((l) => l.position)).toEqual([0, 1, 2])
  })
})

describe('previewing an invoice line', () => {
  it('snapshots the product name and SKU', () => {
    const preview = previewInvoiceLine(line(), { name: 'Speaker', sku: 'SPK-1' })
    expect(preview.name).toBe('Speaker')
    expect(preview.sku).toBe('SPK-1')
    expect(preview.line_total).toBe(1000)
  })

  it('carries a one-off line across under its own name', () => {
    const preview = previewInvoiceLine(line({ product_id: null, description: 'Freight' }), null)
    expect(preview.name).toBe('Freight')
    expect(preview.sku).toBeNull()
  })
})

describe('filtering a list of orders', () => {
  it('shows every order by default', () => {
    expect(salesOrderFilterFromParams({})).toEqual(EMPTY_SALES_ORDER_FILTER)
    expect(isSalesOrderFiltered(EMPTY_SALES_ORDER_FILTER)).toBe(false)
  })

  it('reads a status it recognises and ignores one it does not', () => {
    expect(salesOrderFilterFromParams({ status: 'confirmed' }).status).toBe('confirmed')
    expect(salesOrderFilterFromParams({ status: 'nonsense' }).status).toBe('all')
  })

  it('round-trips through the query string, so a view is a link', () => {
    const filter = salesOrderFilterFromParams({ status: 'draft', q: 'acme', owner: 'u1' })
    expect(salesOrderFilterFromParams(
      Object.fromEntries(salesOrderFilterToParams(filter).entries()),
    )).toEqual(filter)
  })

  it('leaves the default out of the query string', () => {
    expect(salesOrderFilterToParams(EMPTY_SALES_ORDER_FILTER).toString()).toBe('')
  })
})

describe('totals across a list', () => {
  /*
   * The rule this app will not break: two currencies do not add up without a
   * rate, and nothing here has one.
   */
  it('never adds two currencies together', () => {
    expect(
      totalsByCurrency([
        { value: 100, currency: 'USD' },
        { value: 50, currency: 'CAD' },
        { value: 25, currency: 'usd' },
      ]),
    ).toEqual([
      { currency: 'CAD', value: 50 },
      { currency: 'USD', value: 125 },
    ])
  })

  it('summarises what is billed, paid and still owed', () => {
    const summary = summariseInvoices(
      [
        invoice({ total: 1000, amount_paid: 400, currency: 'USD' }),
        invoice({ id: 'i2', total: 500, amount_paid: 500, currency: 'USD', status: 'paid' }),
      ],
      '2026-02-01',
    )
    expect(summary.count).toBe(2)
    expect(summary.billed).toEqual([{ currency: 'USD', value: 1500 }])
    expect(summary.paid).toEqual([{ currency: 'USD', value: 900 }])
    expect(summary.outstanding).toEqual([{ currency: 'USD', value: 600 }])
  })

  // A voided invoice is money nobody owes. Counting it would overstate the book.
  it('keeps voided invoices out of the money but still counts them', () => {
    const summary = summariseInvoices(
      [invoice({ total: 1000, status: 'void' }), invoice({ id: 'i2', total: 200 })],
      '2026-02-01',
    )
    expect(summary.count).toBe(2)
    expect(summary.billed).toEqual([{ currency: 'USD', value: 200 }])
  })

  it('counts the overdue ones', () => {
    const summary = summariseInvoices(
      [
        invoice({ due_date: '2026-01-01', status: 'sent' }),
        invoice({ id: 'i2', due_date: '2026-03-01', status: 'sent' }),
        invoice({ id: 'i3', due_date: '2026-01-01', status: 'paid' }),
      ],
      '2026-02-01',
    )
    expect(summary.overdue).toBe(1)
  })
})

describe('sales orders and deals stay apart', () => {
  /*
   * A guard against the instinctive change. If a deal ever turns up in this
   * module's vocabulary, the two concepts have started to merge and the
   * reasoning in docs/SALES_ORDERS_INVOICES.md needs revisiting first.
   */
  it('has no notion of a deal anywhere in its statuses', () => {
    const vocabulary = [
      ...SALES_ORDER_STATUSES,
      ...Object.values(SALES_ORDER_STATUS_LABELS),
      ...Object.values(INVOICE_STATUS_LABELS),
    ].join(' ').toLowerCase()
    expect(vocabulary).not.toContain('deal')
    expect(vocabulary).not.toContain('won')
    expect(vocabulary).not.toContain('lost')
  })

  it('does not borrow a deal status as an order status', () => {
    for (const dealStatus of ['open', 'won', 'lost']) {
      expect(SALES_ORDER_STATUSES as string[]).not.toContain(dealStatus)
    }
  })
})

describe('Invoiced is not a status anybody sets', () => {
  /*
   * It used to be reachable by hand from Confirmed, which was honest while it
   * read "Fulfilled" and meant delivered. It means an invoice exists now, so
   * offering it as a button would let somebody claim one that is not there.
   */
  it('is offered from nowhere', () => {
    for (const status of SALES_ORDER_STATUSES) {
      expect(nextStatuses(status)).not.toContain('fulfilled')
      expect(canTransition(status, 'fulfilled')).toBe(false)
    }
  })

  it('is still terminal once reached', () => {
    expect(nextStatuses('fulfilled')).toEqual([])
  })

  it('still bills, and still freezes the lines', () => {
    // Reaching it through conversion rather than by hand changes nothing about
    // what it means for an order that is already there.
    expect(canInvoice('fulfilled')).toBe(true)
    expect(isEditable('fulfilled')).toBe(false)
  })
})
