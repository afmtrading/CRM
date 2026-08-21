import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import { todayIn } from '@/lib/timezone'
import { CURRENCIES, formatDate, formatDay, formatNumber, formatPrice } from '@/lib/format'
import {
  INVOICE_STATUS_LABELS,
  daysOverdue,
  isOverdue,
  settableInvoiceStatuses,
} from '@/lib/sales'
import type {
  CompanyRow,
  ContactRow,
  InvoiceLineRow,
  InvoicePaymentRow,
  InvoiceRow,
  SalesOrderRow,
} from '@/lib/database.types'
import { Money } from '@/components/money'
import { InvoiceStatusBadge, PageHeader, Section } from '@/components/ui'
import { ActionForm, SubmitButton } from '@/components/action-form'

import {
  addInvoiceLine,
  deleteInvoice,
  recordPayment,
  removeInvoiceLine,
  setInvoiceShipping,
  setInvoiceStatus,
  updateInvoice,
} from '../actions'

export const dynamic = 'force-dynamic'

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()
  const today = todayIn(context.organization.timezone)

  const { data } = await scoped(context, 'invoices').select('*').eq('id', id).maybeSingle()
  if (!data) notFound()
  const invoice = data as InvoiceRow

  const [
    { data: lineRows },
    { data: paymentRows },
    { data: company },
    { data: contact },
    { data: order },
    { data: products },
    { data: channelRows },
  ] =
    await Promise.all([
      scoped(context, 'invoice_lines').select('*').eq('invoice_id', id).order('position'),
      scoped(context, 'invoice_payments').select('*').eq('invoice_id', id).order('paid_at'),
      invoice.company_id
        ? scoped(context, 'companies').select('*').eq('id', invoice.company_id).maybeSingle()
        : Promise.resolve({ data: null }),
      invoice.contact_id
        ? scoped(context, 'contacts').select('*').eq('id', invoice.contact_id).maybeSingle()
        : Promise.resolve({ data: null }),
      invoice.sales_order_id
        ? scoped(context, 'sales_orders').select('*').eq('id', invoice.sales_order_id).maybeSingle()
        : Promise.resolve({ data: null }),
      /*
       * Only for a draft raised on its own — the one kind of invoice whose
       * lines can still change. Everything else is a snapshot, so a picker
       * would be a control that does nothing.
       */
      invoice.sales_order_id === null && invoice.status === 'draft'
        ? scoped(context, 'products')
            .select('id, name, sku, unit, unit_price, unit_cost')
            .is('deleted_at', null)
            .eq('active', true)
            .order('name')
            .limit(500)
        : Promise.resolve({ data: [] }),
      // Sell-side channels only: the database refuses a source-only one here,
      // so the picker should not offer it.
      scoped(context, 'marketplace_profiles')
        .select('company_id, companies(name)')
        .eq('sells_through', true),
    ])

  const lines = (lineRows ?? []) as InvoiceLineRow[]
  const payments = (paymentRows ?? []) as InvoicePaymentRow[]
  const salesOrder = order as SalesOrderRow | null
  /*
   * The only invoice anybody may still change. An invoice from an order is the
   * order's word, and one that has been issued is what the customer received —
   * the database refuses both, and this is the interface agreeing with it.
   */
  const composable =
    invoice.sales_order_id === null && invoice.status === 'draft' && context.canWrite
  const catalogue = (products ?? []) as {
    id: string
    name: string
    sku: string | null
    unit: string
    unit_price: number
    unit_cost: number
  }[]

  const channels = (
    (channelRows ?? []) as { company_id: string; companies: { name: string } | null }[]
  )
    .map((row) => ({ id: row.company_id, name: row.companies?.name ?? 'Unnamed' }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const owed = Number(invoice.total) - Number(invoice.amount_paid)
  const late = daysOverdue(invoice.due_date, today)

  // Draft and unpaid is a correction; anything else would be restating a
  // document somebody has already acted on.
  const currencyFixed = invoice.status !== 'draft' || Number(invoice.amount_paid) !== 0

  return (
    <>
      <PageHeader
        title={invoice.number}
        description={
          (company as CompanyRow | null)?.name
            ? `${(company as CompanyRow).name} · issued ${formatDay(invoice.issue_date)}`
            : `Issued ${formatDay(invoice.issue_date)}`
        }
        actions={
          <>
            <a href={`/invoices/${id}/print`} className="btn-secondary" target="_blank">
              Print
            </a>
            {salesOrder && (
              <Link href={`/purchase-orders/${salesOrder.id}`} className="btn-secondary">
                {salesOrder.number}
              </Link>
            )}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <InvoiceStatusBadge status={invoice.status} />

        {/*
          Sent and void only. Paid and part paid are computed from the ledger
          below — offering them here would be a way to call an invoice settled
          with no money behind it.
        */}
        {context.canWrite &&
          settableInvoiceStatuses(invoice.status).map((next) => (
            <ActionForm key={next} action={setInvoiceStatus}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="status" value={next} />
              <SubmitButton className="btn-secondary px-3 py-1.5 text-sm" pendingLabel="Saving…">
                Mark {INVOICE_STATUS_LABELS[next].toLowerCase()}
              </SubmitButton>
            </ActionForm>
          ))}

        {isOverdue(invoice, today) && (
          <span className="text-xs font-medium text-red-600">{late} days past due</span>
        )}
        {invoice.status === 'void' && (
          <span className="text-xs text-slate-500">
            Void, and it stays void. The number remains in the sequence.
          </span>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Section title="Billed">
            <div className="-mx-5 overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Discount</th>
                    <th className="text-right">Total</th>
                    {composable && <th />}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <span className="font-medium text-slate-800">{line.name}</span>
                        {line.sku && (
                          <span className="ml-1.5 text-xs text-slate-400">{line.sku}</span>
                        )}
                        {line.notes && (
                          <span className="block text-xs text-slate-500">{line.notes}</span>
                        )}
                      </td>
                      <td className="text-right">{formatNumber(Number(line.quantity))}</td>
                      <td className="text-right">
                        {formatPrice(Number(line.unit_price), invoice.currency)}
                      </td>
                      <td className="text-right">
                        {Number(line.discount) > 0 ? (
                          formatPrice(Number(line.discount), invoice.currency)
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="text-right font-medium">
                        {formatPrice(Number(line.line_total), invoice.currency)}
                      </td>
                      {composable && (
                        <td className="text-right">
                          <form action={removeInvoiceLine}>
                            <input type="hidden" name="id" value={line.id} />
                            <input type="hidden" name="invoice_id" value={id} />
                            <button
                              type="submit"
                              className="text-xs text-slate-400 hover:text-red-600"
                            >
                              Remove
                            </button>
                          </form>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {composable && (
              <ActionForm
                action={addInvoiceLine}
                className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-6"
              >
                <input type="hidden" name="invoice_id" value={id} />

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
                  <label className="label" htmlFor="name">
                    Or a description
                  </label>
                  <input id="name" name="name" className="input" placeholder="Consultancy" />
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

                {/* Same pair as a sales order line, and the same rule behind it:
                    the discount is computed from these, never typed. */}
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

            <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
              {composable
                ? 'A draft raised on its own can still be built up. The moment it is marked sent these lines freeze, and the only way back is to void it and raise another.'
                : 'These lines are a snapshot taken when the invoice was raised. Renaming a product or editing the order behind it does not change what this document says.'}
            </p>
          </Section>

          <Section title="Payments">
            {payments.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing received yet.</p>
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
                          {formatPrice(Number(payment.amount), invoice.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {context.canWrite && invoice.status !== 'void' && (
              <ActionForm
                action={recordPayment}
                className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4"
              >
                <input type="hidden" name="invoice_id" value={id} />

                <div>
                  <label className="label" htmlFor="amount">
                    Amount
                  </label>
                  <input id="amount" name="amount" type="number" step="0.01" className="input" />
                  <p className="mt-1 text-xs text-slate-400">Negative to reverse one.</p>
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
                    Record payment
                  </SubmitButton>
                </div>
              </ActionForm>
            )}
          </Section>
        </div>

        <div className="space-y-5">
          <Section title="Totals">
            <dl className="space-y-2 text-sm">
              <Row label="Subtotal">
                <Money value={Number(invoice.subtotal)} currency={invoice.currency} />
              </Row>
              <Row label="Shipping">
                {composable ? (
                  <ActionForm action={setInvoiceShipping} className="flex items-center gap-1">
                    <input type="hidden" name="id" value={id} />
                    <input
                      name="shipping_charge"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={String(invoice.shipping_charge)}
                      className="input w-24 py-1 text-right text-sm"
                      aria-label="Shipping charge"
                    />
                    <SubmitButton
                      className="text-xs text-slate-500 hover:text-slate-900"
                      pendingLabel="Saving…"
                    >
                      Save
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <Money value={Number(invoice.shipping_charge)} currency={invoice.currency} />
                )}
              </Row>
              <Row label="Total" strong>
                <Money value={Number(invoice.total)} currency={invoice.currency} />
              </Row>
              <Row label="Paid">
                <Money value={Number(invoice.amount_paid)} currency={invoice.currency} />
              </Row>
              <Row label="Owed" strong>
                <Money value={owed} currency={invoice.currency} />
              </Row>
            </dl>

            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
              Paid comes from the ledger and nowhere else — there is no way to mark this settled
              without a payment on it.
            </p>
          </Section>

          <Section title="Details">
            <dl className="mb-4 space-y-2 text-sm">
              <Row label="Company">
                {invoice.company_id ? (
                  <Link
                    href={`/companies/${invoice.company_id}`}
                    className="text-brand-700 hover:underline"
                  >
                    {(company as CompanyRow | null)?.name ?? 'Unknown'}
                  </Link>
                ) : (
                  '—'
                )}
              </Row>
              <Row label="Contact">
                {contact
                  ? [(contact as ContactRow).first_name, (contact as ContactRow).last_name]
                      .filter(Boolean)
                      .join(' ') || (contact as ContactRow).email
                  : '—'}
              </Row>
              {/* A snapshot: the document does not change when somebody leaves. */}
              <Row label="Salesperson">{invoice.owner_name ?? '—'}</Row>
              <Row label="From order">
                {salesOrder ? (
                  <Link
                    href={`/purchase-orders/${salesOrder.id}`}
                    className="text-brand-700 hover:underline"
                  >
                    {salesOrder.number}
                  </Link>
                ) : (
                  'Raised on its own'
                )}
              </Row>
            </dl>

            <ActionForm action={updateInvoice} className="space-y-3 border-t border-slate-100 pt-4">
              <input type="hidden" name="id" value={id} />

              {/*
                There was nowhere to set this at all — an invoice took whatever
                currency it was raised with and kept it silently. Editable only
                while the document is still a draft with no money against it,
                because changing a currency converts nothing: every figure keeps
                its number and acquires a new label, which on a document already
                sent is restating history rather than correcting it. The
                database refuses the same cases; this is the interface agreeing.
              */}
              <div>
                <label className="label" htmlFor="currency">
                  Currency
                </label>
                {currencyFixed ? (
                  <>
                    <p className="input bg-slate-50 text-slate-600">{invoice.currency}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      {invoice.status === 'draft'
                        ? 'Fixed once a payment has been recorded.'
                        : 'Fixed once the invoice has been sent.'}
                    </p>
                  </>
                ) : (
                  <select
                    id="currency"
                    name="currency"
                    className="input"
                    defaultValue={invoice.currency}
                  >
                    {CURRENCIES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/*
                Carried from the sales order when there was one, and settable
                directly on an invoice raised on its own. Locked where it came
                from an order: the order is where that fact belongs, and two
                places to change one thing is how they end up disagreeing.
              */}
              <div>
                <label className="label" htmlFor="marketplace_id">
                  Sold through
                </label>
                {invoice.sales_order_id ? (
                  <>
                    <p className="input bg-slate-50 text-slate-600">
                      {channels.find((channel) => channel.id === invoice.marketplace_id)?.name ??
                        'Direct — no marketplace'}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">Set on the sales order.</p>
                  </>
                ) : (
                  <select
                    id="marketplace_id"
                    name="marketplace_id"
                    className="input"
                    defaultValue={invoice.marketplace_id ?? ''}
                  >
                    <option value="">Direct — no marketplace</option>
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="label" htmlFor="due_date">
                  Due date
                </label>
                <input
                  id="due_date"
                  name="due_date"
                  type="date"
                  className="input"
                  defaultValue={invoice.due_date ?? ''}
                />
              </div>

              <div>
                <label className="label" htmlFor="payment_terms">
                  Payment terms
                </label>
                <input
                  id="payment_terms"
                  name="payment_terms"
                  className="input"
                  defaultValue={invoice.payment_terms ?? ''}
                />
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
                  defaultValue={invoice.notes ?? ''}
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
                  defaultValue={invoice.terms ?? ''}
                />
              </div>

              {context.canWrite && (
                <SubmitButton className="btn-primary w-full" pendingLabel="Saving…">
                  Save
                </SubmitButton>
              )}
            </ActionForm>

            {/*
              Deleting is the administrator's escape hatch for an invoice raised
              against the wrong order — it frees that order to be billed again.
              Voiding is the ordinary answer, because it leaves the number in
              the sequence where an audit expects to find it.
            */}
            {context.isAdmin && (
              <ActionForm action={deleteInvoice} className="mt-4 border-t border-slate-100 pt-4">
                <input type="hidden" name="id" value={id} />
                <SubmitButton
                  className="text-sm text-slate-500 hover:text-red-600"
                  pendingLabel="Deleting…"
                >
                  Delete this invoice
                </SubmitButton>
                <p className="mt-1 text-xs text-slate-400">
                  Void it instead unless the invoice should never have existed.
                </p>
              </ActionForm>
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
