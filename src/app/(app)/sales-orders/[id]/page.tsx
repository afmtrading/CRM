import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import { CURRENCIES, formatDate, formatNumber, formatPrice } from '@/lib/format'
import {
  SALES_ORDER_STATUS_HINTS,
  SALES_ORDER_STATUS_LABELS,
  canInvoice,
  documentMargin,
  documentTotals,
  invoiceBlockedReason,
  isEditable,
  ledgerBalance,
  lineName,
  nextStatuses,
  revisionLabel,
} from '@/lib/sales'
import type {
  InvoiceRow,
  SalesOrderLineRow,
  SalesOrderPaymentRow,
  SalesOrderRow,
} from '@/lib/database.types'

/* What each picker actually reads, so the query can ask for exactly that. */
type PickerCompany = { id: string; name: string }
type PickerContact = { id: string; first_name: string; last_name: string; email: string | null }
type PickerUser = { id: string; name: string; email: string }
type PickerLocation = { id: string; name: string }
type PickerProduct = { id: string; name: string; sku: string | null; unit: string }
import { Money } from '@/components/money'
import { PageHeader, SalesOrderStatusBadge, Section } from '@/components/ui'
import { ActionForm, SubmitButton } from '@/components/action-form'

import {
  addSalesOrderLine,
  convertToInvoice,
  deleteSalesOrder,
  recordDeposit,
  removeSalesOrderLine,
  setSalesOrderStatus,
  updateSalesOrder,
} from '../actions'

export const dynamic = 'force-dynamic'

/**
 * How many options a picker will hold.
 *
 * Bounded because the alternative is unbounded: a growing catalogue quietly
 * turns one page load into a full-table read, and nobody scrolls past the first
 * few hundred entries of a dropdown anyway.
 */
const PICKER_LIMIT = 500

export default async function SalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const { data: order } = await scoped(context, 'sales_orders')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (!order) notFound()
  const salesOrder = order as SalesOrderRow

  const [
    { data: lineRows },
    { data: paymentRows },
    { data: companies },
    { data: contacts },
    { data: users },
    { data: locations },
    { data: products },
    { data: invoiceRow },
    { data: channelRows },
  ] = await Promise.all([
    scoped(context, 'sales_order_lines')
      .select('*')
      .eq('sales_order_id', id)
      .order('position'),
    scoped(context, 'sales_order_payments')
      .select('*')
      .eq('sales_order_id', id)
      .order('paid_at'),
    /*
     * The five pickers. Each fetches the columns its <option> needs and no
     * more, and each is bounded — a select element with ten thousand options in
     * it has already failed the person using it, and pulling every column of
     * every company to render a name is a page's worth of transfer for two
     * fields.
     */
    scoped(context, 'companies')
      .select('id, name')
      .is('deleted_at', null)
      .order('name')
      .limit(PICKER_LIMIT),
    scoped(context, 'contacts')
      .select('id, first_name, last_name, email')
      .is('deleted_at', null)
      .order('last_name')
      .limit(PICKER_LIMIT),
    scoped(context, 'users').select('id, name, email').eq('status', 'active').order('name'),
    scoped(context, 'stock_locations').select('id, name').eq('active', true).order('name'),
    scoped(context, 'products')
      .select('id, name, sku, unit')
      .is('deleted_at', null)
      .eq('active', true)
      .order('name')
      .limit(PICKER_LIMIT),
    scoped(context, 'invoices').select('*').eq('sales_order_id', id).maybeSingle(),
    /*
     * The channels a sale can be attributed to. Sell-side only: money running
     * the other way is a purchase, and the database refuses a source-only
     * marketplace here anyway — this keeps the picker from offering one.
     */
    scoped(context, 'marketplace_profiles')
      .select('company_id, companies(name)')
      .eq('sells_through', true),
  ])

  const lines = (lineRows ?? []) as SalesOrderLineRow[]
  const payments = (paymentRows ?? []) as SalesOrderPaymentRow[]
  const invoice = invoiceRow as InvoiceRow | null
  const channels = ((channelRows ?? []) as { company_id: string; companies: { name: string } | null }[])
    .map((row) => ({ id: row.company_id, name: row.companies?.name ?? 'Unnamed' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const catalogue = (products ?? []) as PickerProduct[]
  const productById = new Map(catalogue.map((product) => [product.id, product]))

  const deposits = ledgerBalance(payments)
  const totals = documentTotals(lines, Number(salesOrder.shipping_charge), deposits)
  const margin = documentMargin(lines)
  const editable = isEditable(salesOrder.status) && context.canWrite
  const blocked = invoiceBlockedReason(salesOrder.status)

  const company = ((companies ?? []) as PickerCompany[]).find((c) => c.id === salesOrder.company_id)
  const owner = ((users ?? []) as PickerUser[]).find((u) => u.id === salesOrder.owner_id)

  return (
    <>
      <PageHeader
        title={salesOrder.number}
        description={
          company
            ? `${company.name} · ${SALES_ORDER_STATUS_HINTS[salesOrder.status]}`
            : SALES_ORDER_STATUS_HINTS[salesOrder.status]
        }
        actions={
          <>
            <a href={`/sales-orders/${id}/print`} className="btn-secondary" target="_blank">
              Print
            </a>

            {invoice ? (
              <Link href={`/invoices/${invoice.id}`} className="btn-secondary">
                {invoice.number}
              </Link>
            ) : (
              context.canWrite &&
              canInvoice(salesOrder.status) && (
                <form action={convertToInvoice}>
                  <input type="hidden" name="id" value={id} />
                  <button type="submit" className="btn-primary">
                    Create invoice
                  </button>
                </form>
              )
            )}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <SalesOrderStatusBadge status={salesOrder.status} />

        {/* Forward only, and never back — a deposit already taken is a fact. */}
        {context.canWrite &&
          nextStatuses(salesOrder.status).map((next) => (
            <ActionForm key={next} action={setSalesOrderStatus}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="status" value={next} />
              <SubmitButton
                className="btn-secondary px-3 py-1.5 text-sm"
                pendingLabel="Saving…"
                title={SALES_ORDER_STATUS_HINTS[next]}
              >
                Mark {SALES_ORDER_STATUS_LABELS[next].toLowerCase()}
              </SubmitButton>
            </ActionForm>
          ))}

        {!invoice && blocked && (
          <span className="text-xs text-slate-500">{blocked}</span>
        )}
        {invoice && (
          <span className="text-xs text-slate-500">
            Invoiced as {invoice.number}. Record payments there.
          </span>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* ---------------------------------------------------------------- */}
          <Section title="Lines">
            {lines.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nothing on this order yet. Add a product, or a line of your own.
              </p>
            ) : (
              <div className="-mx-5 overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">Price</th>
                      <th className="text-right">Discount</th>
                      <th className="text-right">Total</th>
                      {editable && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => {
                      const product = line.product_id ? productById.get(line.product_id) : null
                      const revision = revisionLabel(
                        line.revised_rate_type,
                        line.revised_rate,
                        salesOrder.currency,
                      )

                      return (
                        <tr key={line.id}>
                          <td>
                            <span className="font-medium text-slate-800">
                              {lineName(line, product?.name)}
                            </span>
                            {product?.sku && (
                              <span className="ml-1.5 text-xs text-slate-400">{product.sku}</span>
                            )}
                            {line.notes && (
                              <span className="block text-xs text-slate-500">{line.notes}</span>
                            )}
                          </td>
                          <td className="text-right">
                            {formatNumber(Number(line.quantity))}
                            {product?.unit && (
                              <span className="ml-1 text-xs text-slate-400">{product.unit}</span>
                            )}
                          </td>
                          <td className="text-right">
                            {formatPrice(Number(line.unit_price), salesOrder.currency)}
                            {revision && (
                              <span className="block text-xs text-amber-600">{revision}</span>
                            )}
                          </td>
                          <td className="text-right">
                            {Number(line.discount) > 0 ? (
                              formatPrice(Number(line.discount), salesOrder.currency)
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="text-right font-medium">
                            {formatPrice(Number(line.line_total), salesOrder.currency)}
                          </td>
                          {editable && (
                            <td className="text-right">
                              <ActionForm action={removeSalesOrderLine}>
                                <input type="hidden" name="id" value={line.id} />
                                <input type="hidden" name="sales_order_id" value={id} />
                                <SubmitButton
                                  className="text-xs text-slate-400 hover:text-red-600"
                                  pendingLabel="Removing…"
                                >
                                  Remove
                                </SubmitButton>
                              </ActionForm>
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {editable && (
              <ActionForm
                action={addSalesOrderLine}
                className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-6"
              >
                <input type="hidden" name="sales_order_id" value={id} />

                <div className="sm:col-span-2">
                  <label className="label" htmlFor="product_id">
                    Product
                  </label>
                  <select id="product_id" name="product_id" className="input">
                    <option value="">A line of my own</option>
                    {catalogue.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                        {product.sku ? ` · ${product.sku}` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="label" htmlFor="description">
                    Or a description
                  </label>
                  <input id="description" name="description" className="input" placeholder="Freight" />
                </div>

                <div>
                  <label className="label" htmlFor="quantity">
                    Quantity
                  </label>
                  <input
                    id="quantity"
                    name="quantity"
                    type="number"
                    step="0.001"
                    min="0"
                    defaultValue="1"
                    className="input"
                  />
                </div>

                <div>
                  <label className="label" htmlFor="unit_price">
                    Unit price
                  </label>
                  <input
                    id="unit_price"
                    name="unit_price"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue="0"
                    className="input"
                  />
                </div>

                <div>
                  <label className="label" htmlFor="unit_cost">
                    Unit cost
                  </label>
                  <input
                    id="unit_cost"
                    name="unit_cost"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue="0"
                    className="input"
                  />
                </div>

                {/* A revision is a pair: a kind and a value. The database
                    refuses half of one, and the discount follows from both. */}
                <div>
                  <label className="label" htmlFor="revised_rate_type">
                    Revise by
                  </label>
                  <select id="revised_rate_type" name="revised_rate_type" className="input">
                    <option value="">List price</option>
                    <option value="percent">% off</option>
                    <option value="fixed">Fixed price</option>
                  </select>
                </div>

                <div>
                  <label className="label" htmlFor="revised_rate">
                    Rate
                  </label>
                  <input
                    id="revised_rate"
                    name="revised_rate"
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="label" htmlFor="notes">
                    Line note
                  </label>
                  <input id="notes" name="notes" className="input" />
                </div>

                <div className="flex items-end sm:col-span-6">
                  <SubmitButton className="btn-primary" pendingLabel="Adding…">
                    Add line
                  </SubmitButton>
                </div>
              </ActionForm>
            )}
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="Deposits">
            {payments.length === 0 ? (
              <p className="text-sm text-slate-500">
                No deposit taken. The first one moves this order to reserved.
              </p>
            ) : (
              <div className="-mx-5 overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Method</th>
                      <th>Note</th>
                      <th className="text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((payment) => (
                      <tr key={payment.id}>
                        <td>{formatDate(payment.paid_at)}</td>
                        <td>{payment.method ?? '—'}</td>
                        <td className="text-slate-500">{payment.note ?? '—'}</td>
                        <td
                          className={`text-right font-medium ${
                            Number(payment.amount) < 0 ? 'text-red-600' : ''
                          }`}
                        >
                          {formatPrice(Number(payment.amount), salesOrder.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/*
              Append-only. A mistake is corrected with a negative amount, which
              is why there is no edit here and no delete: the ledger is what
              happened rather than what somebody last thought.
            */}
            {context.canWrite && !invoice && salesOrder.status !== 'cancelled' && (
              <ActionForm
                action={recordDeposit}
                className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4"
              >
                <input type="hidden" name="sales_order_id" value={id} />

                <div>
                  <label className="label" htmlFor="amount">
                    Amount
                  </label>
                  <input
                    id="amount"
                    name="amount"
                    type="number"
                    step="0.01"
                    className="input"
                    placeholder="500"
                  />
                  <p className="mt-1 text-xs text-slate-400">Negative to reverse an earlier one.</p>
                </div>

                <div>
                  <label className="label" htmlFor="method">
                    Method
                  </label>
                  <input id="method" name="method" className="input" placeholder="Wire" />
                </div>

                <div>
                  <label className="label" htmlFor="paid_at">
                    Date
                  </label>
                  <input id="paid_at" name="paid_at" type="date" className="input" />
                </div>

                <div className="flex items-end">
                  <SubmitButton className="btn-secondary" pendingLabel="Recording…">
                    Record deposit
                  </SubmitButton>
                </div>
              </ActionForm>
            )}
          </Section>
        </div>

        {/* ------------------------------------------------------------------ */}
        <div className="space-y-5">
          <Section title="Totals">
            <dl className="space-y-2 text-sm">
              <Row label="Subtotal">
                <Money value={totals.subtotal} currency={salesOrder.currency} />
              </Row>
              <Row label="Shipping">
                <Money value={totals.shipping} currency={salesOrder.currency} />
              </Row>
              <Row label="Total" strong>
                <Money value={totals.total} currency={salesOrder.currency} />
              </Row>
              <Row label="Deposits">
                <Money value={totals.paid} currency={salesOrder.currency} />
              </Row>
              <Row label="Balance" strong>
                <Money value={totals.balance} currency={salesOrder.currency} />
              </Row>
            </dl>

            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
              {/* The deal ledger's rule: not knowing is not the same as zero. */}
              {margin === null
                ? 'Margin unknown — no line carries a cost.'
                : `Margin ${formatPrice(margin, salesOrder.currency)} from the line costs.`}
            </p>
          </Section>

          <Section title="Details">
            <ActionForm action={updateSalesOrder} className="space-y-3">
              <input type="hidden" name="id" value={id} />

              <div>
                <label className="label" htmlFor="company_id">
                  Company
                </label>
                <select
                  id="company_id"
                  name="company_id"
                  className="input"
                  defaultValue={salesOrder.company_id ?? ''}
                >
                  <option value="">No company</option>
                  {((companies ?? []) as PickerCompany[]).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label" htmlFor="contact_id">
                  Contact
                </label>
                <select
                  id="contact_id"
                  name="contact_id"
                  className="input"
                  defaultValue={salesOrder.contact_id ?? ''}
                >
                  <option value="">No contact</option>
                  {((contacts ?? []) as PickerContact[]).map((c) => (
                    <option key={c.id} value={c.id}>
                      {[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label" htmlFor="owner_id">
                  Owner
                </label>
                <select
                  id="owner_id"
                  name="owner_id"
                  className="input"
                  defaultValue={salesOrder.owner_id ?? ''}
                >
                  <option value="">Unassigned</option>
                  {((users ?? []) as PickerUser[]).map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label" htmlFor="location_id">
                  Fulfilling from
                </label>
                <select
                  id="location_id"
                  name="location_id"
                  className="input"
                  defaultValue={salesOrder.location_id ?? ''}
                >
                  <option value="">Not set</option>
                  {((locations ?? []) as PickerLocation[]).map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="order_date">
                    Order date
                  </label>
                  <input
                    id="order_date"
                    name="order_date"
                    type="date"
                    className="input"
                    defaultValue={salesOrder.order_date}
                  />
                </div>

                <div>
                  <label className="label" htmlFor="currency">
                    Currency
                  </label>
                  {/*
                    A list, not a free-text box. Three characters accepted
                    anything, and a typo does not fail — it renders as a blank
                    symbol on a document that has already gone to a customer.
                    Frozen once the order leaves draft, because changing it
                    converts nothing: every stored figure keeps its number and
                    quietly acquires a new label.
                  */}
                  <select
                    id="currency"
                    name="currency"
                    className="input"
                    defaultValue={salesOrder.currency}
                    disabled={salesOrder.status !== 'draft'}
                  >
                    {CURRENCIES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                  {salesOrder.status !== 'draft' && (
                    <p className="mt-1 text-xs text-slate-400">
                      Fixed once the order is confirmed.
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="shipping_charge">
                    Shipping
                  </label>
                  <input
                    id="shipping_charge"
                    name="shipping_charge"
                    type="number"
                    step="0.01"
                    min="0"
                    className="input"
                    defaultValue={String(salesOrder.shipping_charge)}
                  />
                </div>

                {/*
                  Which channel this sold through. Blank is the ordinary case —
                  a direct sale to a buyer is not a channel sale — and leaving
                  it blank is different from nobody having recorded it, which is
                  why there is no default.
                */}
                <div className="col-span-2">
                  <label className="label" htmlFor="marketplace_id">
                    Sold through
                  </label>
                  <select
                    id="marketplace_id"
                    name="marketplace_id"
                    className="input"
                    defaultValue={salesOrder.marketplace_id ?? ''}
                  >
                    <option value="">Direct — no marketplace</option>
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                  {channels.length === 0 && (
                    <p className="mt-1 text-xs text-slate-400">
                      No marketplaces set up yet —{' '}
                      <Link href="/marketplaces" className="text-brand-700 hover:underline">
                        add one
                      </Link>
                      .
                    </p>
                  )}
                </div>

                <div>
                  <label className="label" htmlFor="payment_terms">
                    Payment terms
                  </label>
                  <input
                    id="payment_terms"
                    name="payment_terms"
                    className="input"
                    defaultValue={salesOrder.payment_terms ?? ''}
                    placeholder="Net 30"
                  />
                </div>
              </div>

              <div>
                <label className="label" htmlFor="notes">
                  Notes
                </label>
                <textarea
                  id="notes"
                  name="notes"
                  rows={3}
                  className="input"
                  defaultValue={salesOrder.notes ?? ''}
                />
              </div>

              <div>
                <label className="label" htmlFor="terms">
                  Terms
                </label>
                <textarea
                  id="terms"
                  name="terms"
                  rows={2}
                  className="input"
                  defaultValue={salesOrder.terms ?? ''}
                  placeholder="All sales are final."
                />
              </div>

              {context.canWrite && (
                <SubmitButton className="btn-primary w-full" pendingLabel="Saving…">
                  Save details
                </SubmitButton>
              )}
            </ActionForm>
          </Section>

          <Section title="Record">
            <dl className="space-y-2 text-sm">
              <Row label="Raised">{formatDate(salesOrder.created_at)}</Row>
              <Row label="Signed">
                {salesOrder.signed_at ? formatDate(salesOrder.signed_at) : 'Not yet'}
              </Row>
              <Row label="Owner">{owner ? owner.name || owner.email : 'Unassigned'}</Row>
            </dl>

            {/* No link to a deal, by design. The two are separate concepts and
                docs/SALES_ORDERS_INVOICES.md says why. */}
            {context.canWrite && !invoice && (
              <form action={deleteSalesOrder} className="mt-4 border-t border-slate-100 pt-4">
                <input type="hidden" name="id" value={id} />
                <button type="submit" className="text-sm text-slate-500 hover:text-red-600">
                  Delete this order
                </button>
              </form>
            )}
          </Section>
        </div>
      </div>
    </>
  )
}

function Row({
  label,
  strong,
  children,
}: {
  label: string
  strong?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className={strong ? 'font-semibold text-slate-900' : 'text-slate-700'}>{children}</dd>
    </div>
  )
}
