import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import {
  CURRENCIES,
  currencySymbol,
  formatDate,
  formatNumber,
  formatPrice,
} from '@/lib/format'
import {
  SALES_ORDER_STATUS_HINTS,
  SALES_ORDER_STATUS_LABELS,
  canInvoice,
  documentMargin,
  documentRevisionLabel,
  documentTotals,
  invoiceBlockedReason,
  isEditable,
  ledgerBalance,
  nextStatuses,
} from '@/lib/sales'
import type {
  DocumentHistoryRow,
  InvoiceRow,
  SalesOrderLineRow,
  SalesOrderPaymentRow,
  SalesOrderRow,
} from '@/lib/database.types'

/* What each picker actually reads, so the query can ask for exactly that. */
type PickerCompany = { id: string; name: string; code: string | null }
type PickerContact = {
  id: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  company_id: string | null
}
type PickerUser = { id: string; name: string; email: string }
type PickerLocation = { id: string; name: string }
type PickerProduct = {
  id: string
  name: string
  sku: string | null
  unit: string
  unit_price: number
  /** Null means "derive it from retail", which is derivePricing's job. */
  price_wholesale: number | null
}
import { Empty } from '@/components/contact-cards'
import { CompanyContactPickers } from '@/components/party-pickers'
import { DocumentLines } from '@/components/document-lines'
import { derivePricing } from '@/lib/products'
import { PageHeader, SalesOrderStatusBadge, Section } from '@/components/ui'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { RecordHistory } from '@/components/record-history'
import type { HistoryLookups } from '@/lib/document-history'

import {
  addSalesOrderLine,
  convertToInvoice,
  deleteSalesOrder,
  removeSalesOrderLine,
  updateSalesOrderLine,
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

/**
 * How much of a document's history the card holds.
 *
 * Bounded for the reason the pickers are: an order edited every day for a year
 * would turn one page load into a growing table scan. The card says when it is
 * showing a slice.
 */
const HISTORY_LIMIT = 200

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
    { data: stampRows },
    { data: historyRows },
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
      // `code` is the Customer ID the order prints — see 20260264000000.
      .select('id, name, code')
      .is('deleted_at', null)
      .order('name')
      .limit(PICKER_LIMIT),
    scoped(context, 'contacts')
      // company_id is what lets the contact picker narrow to one company.
      .select('id, first_name, last_name, email, phone, company_id')
      .is('deleted_at', null)
      .order('last_name')
      .limit(PICKER_LIMIT),
    scoped(context, 'users').select('id, name, email').eq('status', 'active').order('name'),
    scoped(context, 'stock_locations').select('id, name').eq('active', true).order('name'),
    scoped(context, 'products')
      // The two price columns are what a picked line is priced from. Two
      // numbers per row on a list that is already bounded by PICKER_LIMIT.
      .select('id, name, sku, unit, unit_price, price_wholesale')
      .is('deleted_at', null)
      .eq('active', true)
      .order('name')
      .limit(PICKER_LIMIT),
    scoped(context, 'invoices').select('*').eq('sales_order_id', id).maybeSingle(),
    /*
     * Everyone who has ever touched this order, disabled users included — the
     * history names them, and somebody since disabled still made the change
     * they made. Bounded: a card in a sidebar is for the recent past.
     */
    scoped(context, 'users').select('id, name, email'),
    scoped(context, 'document_history')
      .select('*')
      .eq('entity', 'sales_order')
      .eq('entity_id', id)
      .order('seq', { ascending: false })
      .limit(HISTORY_LIMIT),
  ])

  const stamps = new Map(
    ((stampRows ?? []) as PickerUser[]).map((user) => [user.id, user.name || user.email]),
  )
  const history = (historyRows ?? []) as DocumentHistoryRow[]

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
  const totals = documentTotals(lines, Number(salesOrder.shipping_charge), deposits, {
    rateType: salesOrder.discount_type,
    rate: salesOrder.discount_rate === null ? null : Number(salesOrder.discount_rate),
  })
  const margin = documentMargin(lines)
  const editable = isEditable(salesOrder.status) && context.canWrite
  const blocked = invoiceBlockedReason(salesOrder.status)

  const companyList = (companies ?? []) as PickerCompany[]
  const company = companyList.find((c) => c.id === salesOrder.company_id)

  /* The two pickers' shapes: a company is a name, a contact is a name and the
     company it lets the list narrow to. */
  const companyOptions = companyList.map((one) => ({ id: one.id, name: one.name }))

  /*
   * The two people the document has to be able to reach, read from their own
   * records rather than copied onto the order. An email kept in two places is
   * an email that can disagree with itself.
   */
  const contactList = (contacts ?? []) as PickerContact[]
  const billTo = contactList.find((one) => one.id === salesOrder.contact_id)
  const shipTo = contactList.find((one) => one.id === salesOrder.ship_to_contact_id)

  /* What the lines add up to in units, which the printed document leads with. */
  const totalQuantity = lines.reduce((sum, line) => sum + Number(line.quantity), 0)
  const companyNames = new Map(companyList.map((one) => [one.id, one.name]))
  const contactOptions = ((contacts ?? []) as PickerContact[]).map((one) => ({
    id: one.id,
    label: [one.first_name, one.last_name].filter(Boolean).join(' ') || (one.email ?? 'Unnamed'),
    companyId: one.company_id,
    companyName: one.company_id ? (companyNames.get(one.company_id) ?? null) : null,
  }))
  /*
   * Whoever raised it and whoever last touched it.
   *
   * Looked up in their own query rather than in the picker list above: that one
   * is active users only, and somebody who has since been disabled still
   * created the orders they created.
   */
  const lookups: HistoryLookups = {
    users: stamps,
    companies: new Map(companyList.map((one) => [one.id, one.name])),
    contacts: new Map(
      contactList.map((one) => [
        one.id,
        [one.first_name, one.last_name].filter(Boolean).join(' ') || (one.email ?? 'Unnamed'),
      ]),
    ),
    locations: new Map(
      ((locations ?? []) as PickerLocation[]).map((one) => [one.id, one.name]),
    ),
  }

  return (
    <>
      <PageHeader
        title={salesOrder.number}
        /* The company, and nothing else. The status hint that used to follow it
           explained the badge in words nobody recognised — "Signed, or a
           deposit taken" for Reserved — and the badge is right there. */
        description={company?.name}
        actions={
          <>
            {/*
              Two doors onto the same route. Opening it previews the document
              inline, which is what somebody checking one before sending it
              wants; ?download=1 sets the attachment disposition and saves it
              as PO-…pdf.
            */}
            <a href={`/sales-orders/${id}/pdf`} className="btn-secondary" target="_blank">
              Preview
            </a>
            <a href={`/sales-orders/${id}/pdf?download=1`} className="btn-secondary">
              Download PDF
            </a>

            {/*
              Deleting sits with the other things you do to the whole document
              rather than at the bottom of a card about who touched it. Offered
              only while no invoice exists: an order that has been billed is
              referenced by one, and the invoice is the record that matters.
            */}
            {context.canWrite &&
              (invoice ? (
                /*
                  Shown rather than hidden, and disabled rather than a trap.
                  soft_delete_sales_order refuses an invoiced order — it is the
                  evidence behind a document somebody has been sent — so the
                  button that cannot work says why instead of vanishing and
                  leaving the reader wondering where it went.
                */
                <button
                  type="button"
                  disabled
                  className="btn-secondary cursor-not-allowed text-slate-400 opacity-60"
                  title={`Invoiced as ${invoice.number}. Void or delete the invoice first.`}
                >
                  Delete this order
                </button>
              ) : (
                <ActionForm action={deleteSalesOrder}>
                  <input type="hidden" name="id" value={id} />
                  <SubmitButton
                    className="btn-secondary text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                    pendingLabel="Deleting…"
                  >
                    Delete this order
                  </SubmitButton>
                </ActionForm>
              ))}

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
          {/*
            Who it is for, and where it goes.
            
            Two parties rather than one: the business being billed is not always
            the address the goods arrive at — a broker buys and a warehouse
            receives — and a document that can only name one of them makes the
            other somebody's note. Ship to empty means "the same as bill to",
            which is the ordinary case and is why nothing is defaulted into it.
          */}
          <Section title="Customer & Shipping">
            <ActionForm action={updateSalesOrder} className="grid gap-5 sm:grid-cols-2">
              <input type="hidden" name="id" value={id} />

              <div className="space-y-3">
                <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  Bill to
                </h3>
                <CompanyContactPickers
                  idPrefix="bill-to"
                  companies={companyOptions}
                  contacts={contactOptions}
                  defaultCompanyId={salesOrder.company_id ?? ''}
                  defaultContactId={salesOrder.contact_id ?? ''}
                />
                {/*
                  Read from the records rather than typed again here. An email
                  kept in two places is an email that can disagree with itself,
                  and the one on the contact is the one the rest of the app
                  writes to.
                */}
                <dl className="space-y-1 border-t border-slate-100 pt-3 text-sm">
                  <Row label="Customer ID">{company?.code ?? <Empty />}</Row>
                  <Row label="Contact email">{billTo?.email ?? <Empty />}</Row>
                  <Row label="Contact phone">{billTo?.phone ?? <Empty />}</Row>
                </dl>
              </div>

              <div className="space-y-3">
                <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  Ship to
                </h3>
                <CompanyContactPickers
                  idPrefix="ship-to"
                  companyName="ship_to_company_id"
                  contactName="ship_to_contact_id"
                  companies={companyOptions}
                  contacts={contactOptions}
                  defaultCompanyId={salesOrder.ship_to_company_id ?? ''}
                  defaultContactId={salesOrder.ship_to_contact_id ?? ''}
                />
                <div>
                  <label className="label" htmlFor="shipping_address">
                    Shipping address
                  </label>
                  {/* Free text, because an address given for one order is not
                      necessarily the address on the company record. */}
                  <textarea
                    id="shipping_address"
                    name="shipping_address"
                    rows={3}
                    className="input"
                    defaultValue={salesOrder.shipping_address ?? ''}
                    placeholder="Where the goods go"
                  />
                </div>
                <dl className="space-y-1 border-t border-slate-100 pt-3 text-sm">
                  <Row label="Contact email">{shipTo?.email ?? <Empty />}</Row>
                  <Row label="Contact phone">{shipTo?.phone ?? <Empty />}</Row>
                </dl>
              </div>

              {context.canWrite && (
                <div className="sm:col-span-2">
                  <SubmitButton className="btn-primary" pendingLabel="Saving…">
                    Save customer &amp; shipping
                  </SubmitButton>
                </div>
              )}
            </ActionForm>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="Sales Order Detail">
            <ActionForm action={updateSalesOrder} className="space-y-3">
              <input type="hidden" name="id" value={id} />

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">S.O. #</label>
                  {/* Allocated once at creation and never reissued, which is
                      why it is shown rather than offered. */}
                  <p className="input bg-slate-50 font-medium text-slate-900">
                    {salesOrder.number}
                  </p>
                </div>

                <div>
                  <label className="label" htmlFor="order_date">
                    S.O. date
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
                  <label className="label" htmlFor="owner_id">
                    Representative
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
                  <label className="label" htmlFor="payment_terms">
                    Payment terms
                  </label>
                  <input
                    id="payment_terms"
                    name="payment_terms"
                    className="input"
                    defaultValue={salesOrder.payment_terms ?? ''}
                    placeholder="Net 30, COD, Prepaid"
                  />
                </div>

                <div>
                  <label className="label" htmlFor="currency">
                    Currency
                  </label>
                  {/*
                    A list, not a free-text box. Frozen once the order leaves
                    draft, because changing it converts nothing: every stored
                    figure keeps its number and quietly acquires a new label.
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
              </div>

              <div className="border-t border-slate-100 pt-3">
                {/*
                  A checkbox posts nothing when it is clear, which is
                  indistinguishable from a card that never asked. The hidden
                  false in front of it means the key is always sent; the
                  checkbox overrides it when ticked, because the last value of
                  a repeated name is the one that wins.
                */}
                <input type="hidden" name="show_discount" value="false" />
                <label className="mb-2 flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="show_discount"
                    value="true"
                    defaultChecked={salesOrder.show_discount}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Show the discount column on the document
                </label>

                <div className="mt-3">
                  <label className="label" htmlFor="deposit_information">
                    Deposit information
                  </label>
                  <input
                    id="deposit_information"
                    name="deposit_information"
                    className="input"
                    defaultValue={salesOrder.deposit_information ?? ''}
                    placeholder="50% on order, balance before collection"
                  />
                  {/* The terms, not the money. What has actually been taken is
                      the ledger below. */}
                  <p className="mt-1 text-xs text-slate-400">
                    What is owed and when. Deposits actually taken are recorded below.
                  </p>
                </div>
              </div>

              {context.canWrite && (
                <SubmitButton className="btn-primary" pendingLabel="Saving…">
                  Save detail
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
            <DocumentLines
              parentKey="sales_order_id"
              parentId={id}
              actions={{
                add: addSalesOrderLine,
                update: updateSalesOrderLine,
                remove: removeSalesOrderLine,
              }}
              currency={salesOrder.currency}
              editable={editable && context.canWrite}
              products={catalogue.map((product) => ({
                id: product.id,
                name: product.name,
                sku: product.sku,
                unit: product.unit,
                // Derived here so the rule that a blank wholesale price means a
                // share of retail has one implementation, in lib/products.
                wholesale: derivePricing(product).unit.wholesale.value,
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
          {/*
            Notes, and only notes.
            
            Terms and conditions were here and are gone: the desk does not want
            a per-order terms box. The column is untouched — nothing on this
            page writes it now, because the header action only writes the keys
            the submitted form actually carries — so the words already stored
            are still there for anybody who wants them back.
          */}
          <Section title="Notes">
            <ActionForm action={updateSalesOrder} className="space-y-3">
              <input type="hidden" name="id" value={id} />

              <div>
                <label className="label" htmlFor="notes">
                  Customer notes
                </label>
                <textarea
                  id="notes"
                  name="notes"
                  rows={5}
                  className="input"
                  defaultValue={salesOrder.notes ?? ''}
                  placeholder="Anything the customer should see on the order…"
                />
              </div>

              {context.canWrite && (
                <SubmitButton className="btn-primary" pendingLabel="Saving…">
                  Save notes
                </SubmitButton>
              )}
            </ActionForm>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="Shipping">
            <ActionForm action={updateSalesOrder} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="id" value={id} />

              {/*
                Shipping leads, and the method follows it — who moves the goods
                is the term of the deal, and what they move them in is a detail
                of carrying it out. The column behind this is still called
                shipping_responsibility: renaming it would be a migration for a
                label, and every order already stored under it would have to
                move for nothing.
              */}
              <div>
                <label className="label" htmlFor="shipping_responsibility">
                  Shipping
                </label>
                {/* Free text rather than a fixed list: who moves the goods is
                    a term of the deal, and every desk words it differently. */}
                <input
                  id="shipping_responsibility"
                  name="shipping_responsibility"
                  className="input"
                  defaultValue={salesOrder.shipping_responsibility ?? ''}
                  placeholder="Buyer Pick Up or Seller Delivery"
                />
              </div>

              <div>
                <label className="label" htmlFor="shipping_method">
                  Shipping method
                </label>
                <input
                  id="shipping_method"
                  name="shipping_method"
                  className="input"
                  defaultValue={salesOrder.shipping_method ?? ''}
                  placeholder="Truck, Plane, Car, etc."
                />
              </div>

              {context.canWrite && (
                <div className="sm:col-span-2">
                  <SubmitButton className="btn-primary" pendingLabel="Saving…">
                    Save shipping
                  </SubmitButton>
                </div>
              )}
            </ActionForm>
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
                className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-5"
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

                {/*
                  The Note column above had nothing that could fill it. The
                  action has always written this field — a deposit's note is
                  what tells a wire from a cheque number from "against the
                  March order" months later — and the form simply never asked.
                */}
                <div>
                  <label className="label" htmlFor="note">
                    Note
                  </label>
                  <input
                    id="note"
                    name="note"
                    className="input"
                    placeholder="Cheque 1042, or why"
                  />
                </div>

                <div className="flex items-end sm:col-span-5">
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
          <Section title="Summary">
            <dl className="space-y-2 text-sm">
              {/* The count the document prints, which is the lines' quantities
                  rather than the number of lines. */}
              <Row label="Total quantity">{formatNumber(totalQuantity)}</Row>
              <Row label="Subtotal">
                {formatPrice(totals.subtotal, salesOrder.currency)}
              </Row>

              {/*
                Money off the whole order, set where its effect is visible.

                A desk that agrees "5% off the job" had to spread it across
                every line by hand and hope the arithmetic came out — a
                discount the document could not state and the next person could
                not check. Taken off the subtotal, before shipping: carriage is
                what it costs to send the goods, and a discount on the goods
                does not make the truck cheaper.
              */}
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">Discount</dt>
                <dd className="text-slate-700">
                  {editable && context.canWrite ? (
                    <ActionForm action={updateSalesOrder} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={id} />
                      <input
                        name="discount_rate"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={salesOrder.discount_rate ?? ''}
                        placeholder="—"
                        className="input w-16 px-2 py-1 text-right text-sm"
                        aria-label="Order discount"
                      />
                      {/* The pair a line's revision uses, and the same two
                          choices. Clearing the rate clears the kind with it —
                          lib/sales-order-header does that, because half a pair
                          is what the table's CHECK refuses. */}
                      <select
                        name="discount_type"
                        defaultValue={salesOrder.discount_type ?? 'percent'}
                        className="input w-14 px-1 py-1 text-sm"
                        aria-label="Order discount kind"
                      >
                        <option value="percent">%</option>
                        <option value="fixed">$</option>
                      </select>
                      <SubmitButton
                        className="text-xs text-slate-500 hover:text-slate-900"
                        pendingLabel="…"
                      >
                        Save
                      </SubmitButton>
                    </ActionForm>
                  ) : (
                    (documentRevisionLabel(
                      salesOrder.discount_type,
                      salesOrder.discount_rate,
                      salesOrder.currency,
                    ) ?? <Empty />)
                  )}
                </dd>
              </div>

              {/* What that comes to, only once it comes to something. */}
              {totals.discount > 0 && (
                <Row label="Less discount">
                  <span className="text-red-600">
                    −{formatPrice(totals.discount, salesOrder.currency)}
                  </span>
                </Row>
              )}

              {/*
                Shipping had no field anywhere. The column and the header
                action have always taken one — the Summary simply printed
                $0.00 with nothing that could change it.
              */}
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">Shipping</dt>
                <dd className="text-slate-700">
                  {editable && context.canWrite ? (
                    <ActionForm action={updateSalesOrder} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={id} />
                      {/* The symbol in front, because a bare "2000" in a box
                          beside "$2,600.00" reads as a quantity. */}
                      <span className="relative">
                        <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-sm text-slate-400">
                          {currencySymbol(salesOrder.currency)}
                        </span>
                        <input
                          name="shipping_charge"
                          type="number"
                          step="0.01"
                          min="0"
                          defaultValue={String(salesOrder.shipping_charge)}
                          className="input w-24 py-1 pl-5 text-right text-sm"
                          aria-label="Shipping charge"
                        />
                      </span>
                      <SubmitButton
                        className="text-xs text-slate-500 hover:text-slate-900"
                        pendingLabel="…"
                      >
                        Save
                      </SubmitButton>
                    </ActionForm>
                  ) : (
                    formatPrice(totals.shipping, salesOrder.currency)
                  )}
                </dd>
              </div>
              <Row label="Total" strong>
                {formatPrice(totals.total, salesOrder.currency)}
              </Row>
              <Row label="Deposits">
                {formatPrice(totals.paid, salesOrder.currency)}
              </Row>
              <Row label="Balance" strong>
                {formatPrice(totals.balance, salesOrder.currency)}
              </Row>
            </dl>

            {/*
              The margin line is gone. It spent most of its life saying it did
              not know, because a sales order's lines rarely carry a cost —
              a sentence that is usually an apology is not worth the room.
            */}
            {margin !== null && (
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
                Margin {formatPrice(margin, salesOrder.currency)} from the line costs.
              </p>
            )}
          </Section>

          {/*
            Who touched it, and when.

            Two facts rather than a list: the row carries created_by and
            updated_by and nothing else, so this says exactly what is stored.
            A real audit trail would need a table of its own, and inventing one
            out of two columns would be a history that quietly skips every
            change but the last.
          */}
          {/*
            Every change, not just the last one.

            This card used to show created_by and updated_by, which is all the
            row stores — edit an order five times and it showed the fifth. The
            four before it were never anywhere. document_history records each
            change as it happens; see 20260272000000.
          */}
          <Section title="Record history">
            <RecordHistory rows={history} currency={salesOrder.currency} lookups={lookups} />
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
