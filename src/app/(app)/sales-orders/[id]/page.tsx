import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import { CURRENCIES, formatDate, formatPrice } from '@/lib/format'
import {
  SALES_ORDER_STATUS_HINTS,
  SALES_ORDER_STATUS_LABELS,
  canInvoice,
  documentMargin,
  documentTotals,
  invoiceBlockedReason,
  isEditable,
  ledgerBalance,
  nextStatuses,
} from '@/lib/sales'
import type {
  InvoiceRow,
  SalesOrderLineRow,
  SalesOrderPaymentRow,
  SalesOrderRow,
} from '@/lib/database.types'

/* What each picker actually reads, so the query can ask for exactly that. */
type PickerCompany = { id: string; name: string }
type PickerContact = {
  id: string
  first_name: string
  last_name: string
  email: string | null
  company_id: string | null
}
type PickerUser = { id: string; name: string; email: string }
type PickerLocation = { id: string; name: string }
type PickerProduct = { id: string; name: string; sku: string | null; unit: string }
import { Money } from '@/components/money'
import { CompanyContactPickers } from '@/components/party-pickers'
import { SalesOrderLines } from '@/components/sales-order-lines'
import { PageHeader, SalesOrderStatusBadge, Section } from '@/components/ui'
import { ActionForm, SubmitButton } from '@/components/action-form'

import {
  convertToInvoice,
  deleteSalesOrder,
  recordDeposit,
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
      // company_id is what lets the contact picker narrow to one company.
      .select('id, first_name, last_name, email, company_id')
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
  ])

  const lines = (lineRows ?? []) as SalesOrderLineRow[]
  const payments = (paymentRows ?? []) as SalesOrderPaymentRow[]
  const invoice = invoiceRow as InvoiceRow | null
  const catalogue = (products ?? []) as PickerProduct[]

  /*
   * What a line may be counted in: whatever this organization's catalogue
   * already uses, plus the three every warehouse has. Drawn from the data
   * rather than from a settings screen nobody asked for — an organization that
   * counts in cases already has "Case" on its products.
   */
  const units = [
    ...new Set(
      ['Unit', 'Case', 'Pallet']
        .concat(catalogue.map((product) => product.unit ?? ''))
        .concat(lines.map((line) => line.unit ?? ''))
        .map((unit) => unit.trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b))

  const deposits = ledgerBalance(payments)
  const totals = documentTotals(lines, Number(salesOrder.shipping_charge), deposits)
  const margin = documentMargin(lines)
  const editable = isEditable(salesOrder.status) && context.canWrite
  const blocked = invoiceBlockedReason(salesOrder.status)

  const companyList = (companies ?? []) as PickerCompany[]
  const company = companyList.find((c) => c.id === salesOrder.company_id)

  /* The two pickers' shapes: a company is a name, a contact is a name and the
     company it lets the list narrow to. */
  const companyOptions = companyList.map((one) => ({ id: one.id, name: one.name }))
  const companyNames = new Map(companyList.map((one) => [one.id, one.name]))
  const contactOptions = ((contacts ?? []) as PickerContact[]).map((one) => ({
    id: one.id,
    label: [one.first_name, one.last_name].filter(Boolean).join(' ') || (one.email ?? 'Unnamed'),
    companyId: one.company_id,
    companyName: one.company_id ? (companyNames.get(one.company_id) ?? null) : null,
  }))
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
          <Section title="Sales Order Details">
            <ActionForm action={updateSalesOrder} className="space-y-3">
              <input type="hidden" name="id" value={id} />

              {/*
                Searchable, and the second narrows to the first: a company you
                can type at rather than scroll, and then only the people who
                work there. The deal form asks the same question of the same two
                tables — see CompanyContactPickers, which both now render.
              */}
              <CompanyContactPickers
                idPrefix="sales-order"
                companies={companyOptions}
                contacts={contactOptions}
                defaultCompanyId={salesOrder.company_id ?? ''}
                defaultContactId={salesOrder.contact_id ?? ''}
              />

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

              {context.canWrite && (
                <SubmitButton className="btn-primary w-full" pendingLabel="Saving…">
                  Save details
                </SubmitButton>
              )}
            </ActionForm>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="Items">
            {/*
              The lines, edited where they are read. One block per line rather
              than a table of eight input columns — see components/sales-order-
              lines, which also holds the item field that tells a catalogue
              product from a line somebody typed.
            */}
            <SalesOrderLines
              orderId={id}
              currency={salesOrder.currency}
              editable={editable && context.canWrite}
              products={catalogue.map((product) => ({
                id: product.id,
                name: product.name,
                sku: product.sku,
                unit: product.unit,
              }))}
              units={units}
              lines={lines.map((line) => ({
                id: line.id,
                productId: line.product_id,
                description: line.description,
                unit: line.unit,
                quantity: Number(line.quantity),
                unitPrice: Number(line.unit_price),
                unitCost: Number(line.unit_cost),
                revisedRateType: line.revised_rate_type,
                revisedRate: line.revised_rate === null ? null : Number(line.revised_rate),
                notes: line.notes,
                lineTotal: Number(line.line_total),
              }))}
            />
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
