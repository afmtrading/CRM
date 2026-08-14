import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatDate, formatDay, formatNumber, formatPrice } from '@/lib/format'
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

import { deleteInvoice, recordPayment, setInvoiceStatus, updateInvoice } from '../actions'

export const dynamic = 'force-dynamic'

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()
  const today = new Date().toISOString().slice(0, 10)

  const { data } = await scoped(context, 'invoices').select('*').eq('id', id).maybeSingle()
  if (!data) notFound()
  const invoice = data as InvoiceRow

  const [{ data: lineRows }, { data: paymentRows }, { data: company }, { data: contact }, { data: order }] =
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
    ])

  const lines = (lineRows ?? []) as InvoiceLineRow[]
  const payments = (paymentRows ?? []) as InvoicePaymentRow[]
  const salesOrder = order as SalesOrderRow | null
  const owed = Number(invoice.total) - Number(invoice.amount_paid)
  const late = daysOverdue(invoice.due_date, today)

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
              <Link href={`/sales-orders/${salesOrder.id}`} className="btn-secondary">
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
            <form key={next} action={setInvoiceStatus}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="status" value={next} />
              <button type="submit" className="btn-secondary px-3 py-1.5 text-sm">
                Mark {INVOICE_STATUS_LABELS[next].toLowerCase()}
              </button>
            </form>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
              These lines are a snapshot taken when the invoice was raised. Renaming a product or
              editing the order behind it does not change what this document says.
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
              <form
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
                  <button type="submit" className="btn-secondary">
                    Record payment
                  </button>
                </div>
              </form>
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
                <Money value={Number(invoice.shipping_charge)} currency={invoice.currency} />
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
                    href={`/sales-orders/${salesOrder.id}`}
                    className="text-brand-700 hover:underline"
                  >
                    {salesOrder.number}
                  </Link>
                ) : (
                  'Raised on its own'
                )}
              </Row>
            </dl>

            <form action={updateInvoice} className="space-y-3 border-t border-slate-100 pt-4">
              <input type="hidden" name="id" value={id} />

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
                <button type="submit" className="btn-primary w-full">
                  Save
                </button>
              )}
            </form>

            {/*
              Deleting is the administrator's escape hatch for an invoice raised
              against the wrong order — it frees that order to be billed again.
              Voiding is the ordinary answer, because it leaves the number in
              the sequence where an audit expects to find it.
            */}
            {context.isAdmin && (
              <form action={deleteInvoice} className="mt-4 border-t border-slate-100 pt-4">
                <input type="hidden" name="id" value={id} />
                <button type="submit" className="text-sm text-slate-500 hover:text-red-600">
                  Delete this invoice
                </button>
                <p className="mt-1 text-xs text-slate-400">
                  Void it instead unless the invoice should never have existed.
                </p>
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
