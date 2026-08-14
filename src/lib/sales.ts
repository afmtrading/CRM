/**
 * Sales orders and invoices: the money, and the two status machines.
 *
 * Everything here is pure, and everything here has a counterpart in SQL. The
 * database is what actually enforces these rules — a line's discount is written
 * by a trigger, an invoice's status follows its payment ledger — and this module
 * exists so a form can show the same numbers before it saves them. Where the two
 * disagree the database wins and the user sees a failure rather than a wrong
 * total, which is the same bargain the rest of this app makes with RLS.
 *
 * See docs/SALES_ORDERS_INVOICES.md, and the migration that carries the SQL
 * side of these formulas.
 */

import { formatPrice } from '@/lib/format'
import type {
  InvoiceLineRow,
  InvoiceRow,
  InvoiceStatus,
  RevisedRateType,
  SalesOrderLineRow,
  SalesOrderStatus,
} from '@/lib/database.types'

// -----------------------------------------------------------------------------
// Money
// -----------------------------------------------------------------------------

/**
 * Rounds to cents.
 *
 * Every money value crosses this on its way out, because the alternative is
 * that 0.1 + 0.2 turns up on an invoice. Amounts are small enough that a double
 * is exact to the cent once rounded, which is why this app has no decimal
 * library.
 */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** What one unit costs after a revised rate — the list price when there is none. */
export function revisedUnitPrice(
  unitPrice: number,
  rateType: RevisedRateType | null | undefined,
  rate: number | null | undefined,
): number {
  if (!rateType || rate === null || rate === undefined) return unitPrice
  // Never below zero: 150% off is the whole line, not money owed back.
  return Math.max(0, rateType === 'percent' ? unitPrice * (1 - rate / 100) : rate)
}

/**
 * Money off one line.
 *
 * Clamped at zero at both ends. A fixed price above list is not a surcharge —
 * somebody typing 120 into a field labelled as a revision meant to charge list,
 * and quietly inflating the order would be the worst possible reading of it.
 */
export function lineDiscount(
  quantity: number,
  unitPrice: number,
  rateType: RevisedRateType | null | undefined,
  rate: number | null | undefined,
): number {
  const revised = revisedUnitPrice(unitPrice, rateType, rate)
  return round2(Math.max(0, quantity * unitPrice - quantity * revised))
}

/** What a line comes to, after its discount. */
export function lineTotal(
  quantity: number,
  unitPrice: number,
  rateType: RevisedRateType | null | undefined,
  rate: number | null | undefined,
): number {
  return round2(round2(quantity * unitPrice) - lineDiscount(quantity, unitPrice, rateType, rate))
}

/** The shape both documents' lines share, as far as arithmetic is concerned. */
interface Priced {
  line_total: number
}

export interface DocumentTotals {
  subtotal: number
  shipping: number
  total: number
  paid: number
  /** What is still owed. Negative when they have overpaid, which is worth seeing. */
  balance: number
}

export function documentTotals(
  lines: Priced[],
  shipping: number = 0,
  paid: number = 0,
): DocumentTotals {
  const subtotal = round2(lines.reduce((sum, line) => round2(sum + Number(line.line_total)), 0))
  const total = round2(subtotal + Number(shipping ?? 0))
  return { subtotal, shipping: round2(Number(shipping ?? 0)), total, paid: round2(paid), balance: round2(total - paid) }
}

/** Nets a payment ledger. Positive rows are money in, negative ones reverse it. */
export function ledgerBalance(rows: { amount: number }[]): number {
  return round2(rows.reduce((sum, row) => round2(sum + Number(row.amount)), 0))
}

/**
 * Cost and margin on a document, or null when nothing has a cost recorded.
 *
 * Null rather than zero, for the reason the deal ledger gives: a margin of zero
 * reads as "we made nothing", and not knowing is a different statement.
 */
export function documentMargin(lines: { line_total: number; line_cost: number }[]): number | null {
  const costed = lines.filter((line) => Number(line.line_cost) > 0)
  if (costed.length === 0) return null
  const revenue = lines.reduce((sum, line) => round2(sum + Number(line.line_total)), 0)
  const cost = lines.reduce((sum, line) => round2(sum + Number(line.line_cost)), 0)
  return round2(revenue - cost)
}

// -----------------------------------------------------------------------------
// Sales order status
// -----------------------------------------------------------------------------

export const SALES_ORDER_STATUSES: SalesOrderStatus[] = [
  'draft',
  'reserved',
  'confirmed',
  'fulfilled',
  'cancelled',
]

export const SALES_ORDER_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  draft: 'Draft',
  reserved: 'Reserved',
  confirmed: 'Confirmed',
  fulfilled: 'Fulfilled',
  cancelled: 'Cancelled',
}

/** One line each, for the screen — a status nobody can explain is not a status. */
export const SALES_ORDER_STATUS_HINTS: Record<SalesOrderStatus, string> = {
  draft: 'Being written. Commits to nothing.',
  reserved: 'Signed, or a deposit taken.',
  confirmed: 'Committed and ready to invoice.',
  fulfilled: 'Delivered and done.',
  cancelled: 'Did not happen.',
}

/**
 * Where an order can go from here.
 *
 * Forward, or cancelled, and nothing goes back. An order that has been signed
 * cannot become a draft again: the deposit on it is a fact, and a status that
 * can walk backwards makes every report over it a question of when you looked.
 * Fulfilled and cancelled are terminal.
 */
export function nextStatuses(status: SalesOrderStatus): SalesOrderStatus[] {
  switch (status) {
    case 'draft':
      return ['reserved', 'confirmed', 'cancelled']
    case 'reserved':
      return ['confirmed', 'cancelled']
    case 'confirmed':
      return ['fulfilled', 'cancelled']
    case 'fulfilled':
    case 'cancelled':
      return []
  }
}

export function canTransition(from: SalesOrderStatus, to: SalesOrderStatus): boolean {
  return nextStatuses(from).includes(to)
}

/** Whether an order is far enough along to bill for. Matches the SQL exactly. */
export function canInvoice(status: SalesOrderStatus): boolean {
  return status === 'confirmed' || status === 'fulfilled'
}

/** Why not, in words the person clicking can act on. */
export function invoiceBlockedReason(status: SalesOrderStatus): string | null {
  if (canInvoice(status)) return null
  if (status === 'cancelled') return 'A cancelled order cannot be invoiced.'
  return 'Confirm the order before invoicing it.'
}

/** An order still being written can have its lines changed. */
export function isEditable(status: SalesOrderStatus): boolean {
  return status !== 'cancelled' && status !== 'fulfilled'
}

// -----------------------------------------------------------------------------
// Invoice status
// -----------------------------------------------------------------------------

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partial: 'Part paid',
  paid: 'Paid',
  void: 'Void',
}

/**
 * An invoice's status, given the money on it.
 *
 * The same function as `invoice_status_for` in the database, which is the one
 * that actually decides. Void is sticky. Paid and partial are facts about
 * money and outrank "sent", which is a flag somebody set by hand.
 */
export function invoiceStatusFor(
  total: number,
  paid: number,
  current: InvoiceStatus,
): InvoiceStatus {
  if (current === 'void') return 'void'
  if (paid <= 0) return current === 'sent' ? 'sent' : 'draft'
  if (paid >= total) return 'paid'
  return 'partial'
}

/**
 * The two an invoice can be set to by hand.
 *
 * Paid and partial are missing on purpose: they are computed from the ledger,
 * and offering them would let somebody mark an invoice paid without any money
 * arriving. Record a payment instead.
 */
export function settableInvoiceStatuses(current: InvoiceStatus): InvoiceStatus[] {
  if (current === 'void') return []
  return (['sent', 'void'] as InvoiceStatus[]).filter((status) => status !== current)
}

/** Past its due date with money still owed. Null dates are never overdue. */
export function isOverdue(invoice: Pick<InvoiceRow, 'due_date' | 'status'>, today: string): boolean {
  if (!invoice.due_date) return false
  if (invoice.status === 'paid' || invoice.status === 'void') return false
  return invoice.due_date < today
}

/** Days late, for sorting an ageing list. Zero when it is not late at all. */
export function daysOverdue(dueDate: string | null, today: string): number {
  if (!dueDate || dueDate >= today) return 0
  const due = Date.parse(`${dueDate}T00:00:00Z`)
  const now = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(due) || Number.isNaN(now)) return 0
  return Math.round((now - due) / 86_400_000)
}

// -----------------------------------------------------------------------------
// Lines
// -----------------------------------------------------------------------------

/**
 * What to call a line.
 *
 * A line names a product or carries its own description, and the database
 * insists on one of them — so falling through to "Item" should never happen. It
 * is here because a table cell with nothing in it is worse than a placeholder,
 * and because an invoice line's name is a snapshot that may outlive its product.
 */
export function lineName(
  line: Pick<SalesOrderLineRow, 'description'>,
  productName?: string | null,
): string {
  return productName?.trim() || line.description?.trim() || 'Item'
}

/**
 * How a revision reads on screen: "10% off", "at $80.00", or nothing at all.
 *
 * Priced to the cent through formatPrice rather than formatCurrency, because a
 * revised unit price is exactly the case that function was written for — round
 * a price list to the dollar and half of it becomes the same number.
 */
export function revisionLabel(
  rateType: RevisedRateType | null | undefined,
  rate: number | null | undefined,
  currency: string,
): string | null {
  if (!rateType || rate === null || rate === undefined) return null
  if (rateType === 'percent') return `${rate}% off`
  return `at ${formatPrice(rate, currency)}`
}

/**
 * Positions renumbered from zero.
 *
 * Lines are reordered by rewriting the whole set, so gaps and duplicates from
 * an earlier edit do not accumulate into an order nobody can predict.
 */
export function renumber<T>(lines: T[]): (T & { position: number })[] {
  return lines.map((line, index) => ({ ...line, position: index }))
}

// -----------------------------------------------------------------------------
// Turning a sales order line into an invoice line
// -----------------------------------------------------------------------------

/**
 * The snapshot rule, for anything that needs to show what an invoice *would*
 * say before one exists.
 *
 * The conversion itself happens in SQL, in one transaction, because a
 * half-written invoice is worse than none. This mirrors it so a preview and the
 * document agree.
 */
export function previewInvoiceLine(
  line: Pick<
    SalesOrderLineRow,
    'product_id' | 'description' | 'notes' | 'quantity' | 'unit_price' | 'unit_cost' | 'discount' | 'line_total' | 'position'
  >,
  product?: { name: string; sku: string | null } | null,
): Omit<InvoiceLineRow, 'id' | 'organization_id' | 'invoice_id' | 'created_at'> {
  return {
    product_id: line.product_id,
    name: lineName(line, product?.name),
    sku: product?.sku ?? null,
    notes: line.notes,
    quantity: line.quantity,
    unit_price: line.unit_price,
    unit_cost: line.unit_cost,
    discount: line.discount,
    line_total: line.line_total,
    position: line.position,
  }
}

// -----------------------------------------------------------------------------
// Filtering a list of documents
// -----------------------------------------------------------------------------

export interface SalesOrderFilter {
  status: SalesOrderStatus | 'all'
  company: string
  owner: string
  search: string
  from: string
  to: string
}

export const EMPTY_SALES_ORDER_FILTER: SalesOrderFilter = {
  status: 'all',
  company: '',
  owner: '',
  search: '',
  from: '',
  to: '',
}

type ParamBag = Record<string, string | string[] | undefined>

function one(params: ParamBag, key: string): string {
  const value = params[key]
  const raw = Array.isArray(value) ? value[0] : value
  return (raw ?? '').trim()
}

export function salesOrderFilterFromParams(params: ParamBag): SalesOrderFilter {
  const status = one(params, 'status')
  return {
    status: (SALES_ORDER_STATUSES as string[]).includes(status)
      ? (status as SalesOrderStatus)
      : 'all',
    company: one(params, 'company'),
    owner: one(params, 'owner'),
    search: one(params, 'q'),
    from: one(params, 'from'),
    to: one(params, 'to'),
  }
}

export function salesOrderFilterToParams(filter: SalesOrderFilter): URLSearchParams {
  const params = new URLSearchParams()
  if (filter.status !== 'all') params.set('status', filter.status)
  if (filter.company) params.set('company', filter.company)
  if (filter.owner) params.set('owner', filter.owner)
  if (filter.search) params.set('q', filter.search)
  if (filter.from) params.set('from', filter.from)
  if (filter.to) params.set('to', filter.to)
  return params
}

export function isSalesOrderFiltered(filter: SalesOrderFilter): boolean {
  return salesOrderFilterToParams(filter).toString().length > 0
}

// -----------------------------------------------------------------------------
// Totals across a list
// -----------------------------------------------------------------------------

export interface MoneyAmount {
  value: number
  currency: string
}

/**
 * Sums per currency, because two currencies do not add up without a rate.
 *
 * The same rule the deal ledger follows, and the reason a sales order carries a
 * currency of its own rather than inheriting one from a setting somewhere.
 */
export function totalsByCurrency(rows: { value: number; currency: string }[]): MoneyAmount[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const currency = (row.currency || '').toUpperCase()
    totals.set(currency, round2((totals.get(currency) ?? 0) + Number(row.value)))
  }
  return [...totals.entries()]
    .map(([currency, value]) => ({ currency, value }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

export interface InvoiceSummary {
  count: number
  billed: MoneyAmount[]
  paid: MoneyAmount[]
  outstanding: MoneyAmount[]
  overdue: number
}

/** What a list of invoices comes to. Void invoices are excluded from the money. */
export function summariseInvoices(invoices: InvoiceRow[], today: string): InvoiceSummary {
  const live = invoices.filter((invoice) => invoice.status !== 'void')

  return {
    count: invoices.length,
    billed: totalsByCurrency(live.map((i) => ({ value: Number(i.total), currency: i.currency }))),
    paid: totalsByCurrency(live.map((i) => ({ value: Number(i.amount_paid), currency: i.currency }))),
    outstanding: totalsByCurrency(
      live.map((i) => ({ value: round2(Number(i.total) - Number(i.amount_paid)), currency: i.currency })),
    ),
    overdue: live.filter((invoice) => isOverdue(invoice, today)).length,
  }
}
