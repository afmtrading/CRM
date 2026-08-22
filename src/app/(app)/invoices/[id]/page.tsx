import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import { todayIn } from '@/lib/timezone'
import {
  CURRENCIES,
  currencySymbol,
  formatDate,
  formatDay,
  formatNumber,
  formatPrice,
} from '@/lib/format'
import {
  INVOICE_STATUS_LABELS,
  daysOverdue,
  documentDiscount,
  documentRevisionLabel,
  isOverdue,
  settableInvoiceStatuses,
} from '@/lib/sales'
import type {
  CompanyRow,
  DocumentHistoryRow,
  ContactRow,
  InvoiceLineRow,
  InvoicePaymentRow,
  InvoiceRow,
  SalesOrderRow,
} from '@/lib/database.types'
import { Empty } from '@/components/contact-cards'
import { InvoiceStatusBadge, PageHeader, Section } from '@/components/ui'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { CompanyContactPickers } from '@/components/party-pickers'
import { DocumentLines } from '@/components/document-lines'
import { derivePricing } from '@/lib/products'
import { RecordHistory } from '@/components/record-history'
import type { HistoryLookups } from '@/lib/document-history'

import {
  addInvoiceLine,
  deleteInvoice,
  recordPayment,
  removeInvoiceLine,
  updateInvoiceLine,
  setInvoiceShipping,
  setInvoiceStatus,
  updateInvoice,
} from '../actions'

export const dynamic = 'force-dynamic'

/** How much of a document's history the card holds. See the sales order page. */
const HISTORY_LIMIT = 200

/** How many options a picker will hold. Same bound the sales order uses. */
const PICKER_LIMIT = 500

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
    { data: people },
    { data: pickCompanies },
    { data: pickContacts },
    { data: historyRows },
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
      /* Everyone the history might name, disabled users included — somebody
         since disabled still made the change they made. */
      scoped(context, 'users').select('id, name, email'),
      /*
       * The two pickers, and only for the invoice that can use them. A sent
       * invoice shows its customer rather than offering one, so fetching three
       * hundred companies to render a name nobody may change is a page's worth
       * of transfer for nothing.
       */
      invoice.sales_order_id === null && invoice.status === 'draft'
        ? scoped(context, 'companies')
            .select('id, name')
            .is('deleted_at', null)
            .order('name')
            .limit(PICKER_LIMIT)
        : Promise.resolve({ data: [] }),
      invoice.sales_order_id === null && invoice.status === 'draft'
        ? scoped(context, 'contacts')
            .select('id, first_name, last_name, company_id')
            .is('deleted_at', null)
            .order('last_name')
            .limit(PICKER_LIMIT)
        : Promise.resolve({ data: [] }),
      scoped(context, 'document_history')
        .select('*')
        .eq('entity', 'invoice')
        .eq('entity_id', id)
        .order('seq', { ascending: false })
        .limit(HISTORY_LIMIT),
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


  const customer = company as CompanyRow | null
  const billTo = contact as ContactRow | null
  const billToName = billTo
    ? [billTo.first_name, billTo.last_name].filter(Boolean).join(' ') || billTo.email
    : null

  /* What the lines add up to in units, which the printed document leads with. */
  const totalQuantity = lines.reduce((sum, line) => sum + Number(line.quantity), 0)

  /* What the stored total already has taken off it, so the card can show it. */
  const discount = documentDiscount(
    Number(invoice.subtotal),
    invoice.discount_type,
    invoice.discount_rate === null ? null : Number(invoice.discount_rate),
  )

  /*
   * What a line may be counted in: whatever the catalogue already uses, plus
   * the three every warehouse has. The same list the sales order builds, from
   * the same reasoning — drawn from the data rather than from a settings screen.
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

  const companyOptions = ((pickCompanies ?? []) as { id: string; name: string }[]).map((one) => ({
    id: one.id,
    name: one.name,
  }))
  const pickedCompanyName = new Map(companyOptions.map((one) => [one.id, one.name]))
  const contactOptions = (
    (pickContacts ?? []) as {
      id: string
      first_name: string
      last_name: string
      company_id: string | null
    }[]
  ).map((one) => ({
    id: one.id,
    label: [one.first_name, one.last_name].filter(Boolean).join(' ') || 'Unnamed',
    companyId: one.company_id,
    companyName: one.company_id ? (pickedCompanyName.get(one.company_id) ?? null) : null,
  }))

  const history = (historyRows ?? []) as DocumentHistoryRow[]
  const lookups: HistoryLookups = {
    users: new Map(
      ((people ?? []) as { id: string; name: string | null; email: string }[]).map((user) => [
        user.id,
        user.name || user.email,
      ]),
    ),
    companies: new Map(
      customer && invoice.company_id ? [[invoice.company_id, customer.name]] : [],
    ),
    contacts: new Map(billToName && invoice.contact_id ? [[invoice.contact_id, billToName]] : []),
    locations: new Map(),
  }

  const owed = Number(invoice.total) - Number(invoice.amount_paid)
  /*
   * Settled, and said so.
   *
   * Read off the money rather than off the status: an invoice with nothing owed
   * is paid in full whether or not the ledger has moved it to Paid yet, and a
   * void one owes nothing because nobody owes anything on a document that was
   * withdrawn.
   */
  const paidInFull = invoice.status !== 'void' && Number(invoice.total) > 0 && owed <= 0
  const late = daysOverdue(invoice.due_date, today)

  // Draft and unpaid is a correction; anything else would be restating a
  // document somebody has already acted on.
  const currencyFixed = invoice.status !== 'draft' || Number(invoice.amount_paid) !== 0

  return (
    <>
      <PageHeader
        title={invoice.number}
        description={
          customer?.name
            ? `${customer.name} · issued ${formatDay(invoice.issue_date)}`
            : `Issued ${formatDay(invoice.issue_date)}`
        }
        actions={
          <>
            <a href={`/invoices/${id}/pdf`} className="btn-secondary" target="_blank">
              Preview
            </a>
            <a href={`/invoices/${id}/pdf?download=1`} className="btn-secondary">
              Download PDF
            </a>
            {salesOrder && (
              <Link href={`/sales-orders/${salesOrder.id}`} className="btn-secondary">
                {salesOrder.number}
              </Link>
            )}

            {/*
              With the other whole-document actions, as on a sales order.
              Still the administrator's escape hatch for an invoice raised
              against the wrong order — voiding is the ordinary answer, because
              it leaves the number in the sequence where an audit expects it.
            */}
            {context.isAdmin && (
              <ActionForm action={deleteInvoice}>
                <input type="hidden" name="id" value={id} />
                <SubmitButton
                  className="btn-secondary text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                  pendingLabel="Deleting…"
                  title="Void it instead unless the invoice should never have existed."
                >
                  Delete this invoice
                </SubmitButton>
              </ActionForm>
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
          {/* ---------------------------------------------------------------- */}
          {/*
            Who it is for, and where it went.

            The same card a sales order opens with, read rather than edited: an
            invoice's customer is a snapshot taken when it was raised, and the
            document has already been sent. Correcting one means voiding it and
            raising another, which is why there is nothing here to change.
          */}
          <Section title="Customer & Shipping">
            {composable ? (
              /*
                An invoice raised on its own has no order to carry a customer
                from, and this card was read on every invoice — which meant the
                only way to name a customer was to go and create a sales order
                for one. It is the order's card now, on the invoice that has
                nowhere else to say these things.
              */
              <ActionForm action={updateInvoice} className="grid gap-5 sm:grid-cols-2">
                <input type="hidden" name="id" value={id} />

                <div className="space-y-3">
                  <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    Bill to
                  </h3>
                  <CompanyContactPickers
                    idPrefix="bill-to"
                    companies={companyOptions}
                    contacts={contactOptions}
                    defaultCompanyId={invoice.company_id ?? ''}
                    defaultContactId={invoice.contact_id ?? ''}
                  />
                  <dl className="space-y-1 border-t border-slate-100 pt-3 text-sm">
                    <Row label="Customer ID">{customer?.code ?? <Empty />}</Row>
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
                    defaultCompanyId={invoice.ship_to_company_id ?? ''}
                    defaultContactId={invoice.ship_to_contact_id ?? ''}
                  />
                  <div>
                    <label className="label" htmlFor="shipping_address">
                      Shipping address
                    </label>
                    <textarea
                      id="shipping_address"
                      name="shipping_address"
                      rows={3}
                      className="input"
                      defaultValue={invoice.shipping_address ?? ''}
                      placeholder="Where the goods go"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="label" htmlFor="shipping_responsibility">
                        Shipping
                      </label>
                      <input
                        id="shipping_responsibility"
                        name="shipping_responsibility"
                        className="input"
                        defaultValue={invoice.shipping_responsibility ?? ''}
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
                        defaultValue={invoice.shipping_method ?? ''}
                        placeholder="Truck, Plane, Car, etc."
                      />
                    </div>
                  </div>
                </div>

                <div className="sm:col-span-2">
                  <SubmitButton className="btn-primary" pendingLabel="Saving…">
                    Save customer &amp; shipping
                  </SubmitButton>
                </div>
              </ActionForm>
            ) : (
              /*
                Read, once the invoice is sent or came from an order. It is a
                snapshot of what the customer received — correcting one means
                voiding it and raising another, which is why there is nothing
                here to change.
              */
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    Bill to
                  </h3>
                  <dl className="space-y-1 text-sm">
                    <Row label="Company">
                      {invoice.company_id ? (
                        <Link
                          href={`/companies/${invoice.company_id}`}
                          className="text-brand-700 hover:underline"
                        >
                          {customer?.name ?? 'Unknown'}
                        </Link>
                      ) : (
                        <Empty />
                      )}
                    </Row>
                    <Row label="Contact">{billToName ?? <Empty />}</Row>
                    <Row label="Customer ID">{customer?.code ?? <Empty />}</Row>
                    <Row label="Contact email">{billTo?.email ?? <Empty />}</Row>
                    <Row label="Contact phone">{billTo?.phone ?? <Empty />}</Row>
                  </dl>
                </div>

                <div className="space-y-3">
                  <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    Ship to
                  </h3>
                  <dl className="space-y-1 text-sm">
                    <Row label="Shipping">{invoice.shipping_responsibility ?? <Empty />}</Row>
                    <Row label="Shipping method">{invoice.shipping_method ?? <Empty />}</Row>
                  </dl>
                  <div>
                    <span className="label">Shipping address</span>
                    {invoice.shipping_address ? (
                      <p className="text-sm whitespace-pre-line text-slate-700">
                        {invoice.shipping_address}
                      </p>
                    ) : (
                      <p className="text-sm text-slate-400">The same as bill to.</p>
                    )}
                  </div>
                  {salesOrder && (
                    <p className="border-t border-slate-100 pt-3 text-xs text-slate-400">
                      Taken from {salesOrder.number} when the invoice was raised.
                    </p>
                  )}
                </div>
              </div>
            )}
          </Section>

          {/* ---------------------------------------------------------------- */}
          {/*
            The Sales Order Detail card, as an invoice states it — same
            two-column grid, same field order, same rules underneath. Three
            differences, and each is a fact about invoices rather than a
            difference in taste: the date is frozen once the document has been
            sent, the representative is a snapshot, and the slot a sales order
            gives to "Fulfilling from" is where an invoice's due date goes.
          */}
          <Section title="Invoice Detail">
            <ActionForm action={updateInvoice} className="space-y-3">
              <input type="hidden" name="id" value={id} />

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">Invoice #</label>
                  {/* Allocated once and never reissued, which is why it is
                      shown rather than offered. Voiding keeps it in the
                      sequence where an audit expects to find it. */}
                  <p className="input bg-slate-50 font-medium text-slate-900">{invoice.number}</p>
                </div>

                <div>
                  <label className="label" htmlFor="issue_date">
                    Invoice date
                  </label>
                  {/*
                    Editable only while this is a draft with no money on it —
                    the same rule the currency follows, for the same reason.
                    Redating a document somebody has already received is
                    restating history rather than correcting it.
                  */}
                  {currencyFixed ? (
                    <>
                      <p className="input bg-slate-50 text-slate-600">
                        {formatDay(invoice.issue_date)}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        {invoice.status === 'draft'
                          ? 'Fixed once a payment has been recorded.'
                          : 'Fixed once the invoice has been sent.'}
                      </p>
                    </>
                  ) : (
                    <input
                      id="issue_date"
                      name="issue_date"
                      type="date"
                      className="input"
                      defaultValue={invoice.issue_date}
                    />
                  )}
                </div>

                <div>
                  <label className="label">Representative</label>
                  {/* A snapshot: the document does not change when somebody
                      leaves, and it is the order's representative rather than
                      whoever raised the invoice. */}
                  <p className="input bg-slate-50 text-slate-600">
                    {invoice.owner_name ?? 'Unassigned'}
                  </p>
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
                    placeholder="Net 30, COD, Prepaid"
                  />
                </div>

                <div>
                  <label className="label" htmlFor="currency">
                    Currency
                  </label>
                  {/*
                    Frozen once the invoice is sent or part paid, because
                    changing it converts nothing: every stored figure keeps its
                    number and quietly acquires a new label. The database
                    refuses the same cases.
                  */}
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
                    defaultChecked={invoice.show_discount}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Show the discount column on the document
                </label>

                {/*
                  "Sold through" was here and is gone. The desk does not want
                  the field on an invoice: it is carried from the order and
                  printed nowhere, so it was a read-only box restating a fact
                  the order already owns.

                  marketplace_id is untouched — channel attribution still reads
                  it, and nothing on this page posts the key now, so the `has`
                  walk in lib/invoice-header never writes it.
                */}
              </div>

              {context.canWrite && (
                <SubmitButton className="btn-primary" pendingLabel="Saving…">
                  Save detail
                </SubmitButton>
              )}
            </ActionForm>
          </Section>

          {/* ---------------------------------------------------------------- */}
          {/* ---------------------------------------------------------------- */}
          {/*
            The same Items card a sales order has, and the same component
            drawing it. This was a read-only table with a six-column add form
            underneath — two shapes for one job, and no way to correct a line
            short of removing it and typing it again.

            Editable only while the invoice is still a draft raised on its own.
            Everything else is a snapshot of what the customer received, and
            the database refuses it through assert_invoice_editable whatever
            this page decides to draw.
          */}
          <Section title="Items">
            <DocumentLines
              parentKey="invoice_id"
              parentId={id}
              actions={{
                add: addInvoiceLine,
                update: updateInvoiceLine,
                remove: removeInvoiceLine,
              }}
              currency={invoice.currency}
              editable={composable}
              products={catalogue.map((product) => ({
                id: product.id,
                name: product.name,
                sku: product.sku,
                unit: product.unit,
                wholesale: derivePricing(product).unit.wholesale.value,
              }))}
              units={units}
              lines={lines.map((line) => ({
                id: line.id,
                productId: line.product_id,
                description: line.name,
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

            <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
              {composable
                ? 'A draft raised on its own can still be built up. The moment it is marked sent these lines freeze, and the only way back is to void it and raise another.'
                : 'These lines are a snapshot taken when the invoice was raised. Renaming a product or editing the order behind it does not change what this document says.'}
            </p>
          </Section>

          {/* ---------------------------------------------------------------- */}
          {/*
            Notes, and only notes — its own card, posting on its own, exactly
            as a sales order's does. Which is why the header now goes through
            lib/invoice-header: a form that does not ask about the payment
            terms must not answer for them.
          */}
          <Section title="Notes">
            <ActionForm action={updateInvoice} className="space-y-3">
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
                  defaultValue={invoice.notes ?? ''}
                  placeholder="Anything the customer should see on the invoice…"
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
                className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-5"
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

                {/* Same gap the deposit ledger had: a Note column with no way
                    to write one. The action has always taken it. */}
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
                    Record payment
                  </SubmitButton>
                </div>
              </ActionForm>
            )}
          </Section>
        </div>

        <div className="space-y-5">
          {/*
            Summary, laid out the way a sales order's is — same rows, same
            order, same card name. An invoice's version of "Deposits" is what
            has actually been paid, and its "Balance" is what is still owed.
          */}
          <Section title="Summary">
            <dl className="space-y-2 text-sm">
              {/* The count the document leads with: the lines' quantities
                  rather than the number of lines. */}
              <Row label="Total quantity">{formatNumber(totalQuantity)}</Row>
              <Row label="Subtotal">
                {formatPrice(Number(invoice.subtotal), invoice.currency)}
              </Row>

              {/*
                Money off the whole invoice — carried from the order when there
                was one, and set here on an invoice raised on its own. Read on
                anything else: the stored total is what the customer received.
              */}
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">Discount</dt>
                <dd className="text-slate-700">
                  {composable ? (
                    <ActionForm action={updateInvoice} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={id} />
                      <input
                        name="discount_rate"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={invoice.discount_rate ?? ''}
                        placeholder="—"
                        className="input w-16 px-2 py-1 text-right text-sm"
                        aria-label="Invoice discount"
                      />
                      <select
                        name="discount_type"
                        defaultValue={invoice.discount_type ?? 'percent'}
                        className="input w-14 px-1 py-1 text-sm"
                        aria-label="Invoice discount kind"
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
                      invoice.discount_type,
                      invoice.discount_rate,
                      invoice.currency,
                    ) ?? <Empty />)
                  )}
                </dd>
              </div>

              {discount > 0 && (
                <Row label="Less discount">
                  <span className="text-red-600">
                    −{formatPrice(discount, invoice.currency)}
                  </span>
                </Row>
              )}

              <Row label="Shipping">
                {composable ? (
                  <ActionForm action={setInvoiceShipping} className="flex items-center gap-1">
                    <input type="hidden" name="id" value={id} />
                    <span className="relative">
                      <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-sm text-slate-400">
                        {currencySymbol(invoice.currency)}
                      </span>
                      <input
                        name="shipping_charge"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={String(invoice.shipping_charge)}
                        className="input w-24 py-1 pl-5 text-right text-sm"
                        aria-label="Shipping charge"
                      />
                    </span>
                    <SubmitButton
                      className="text-xs text-slate-500 hover:text-slate-900"
                      pendingLabel="Saving…"
                    >
                      Save
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  formatPrice(Number(invoice.shipping_charge), invoice.currency)
                )}
              </Row>
              <Row label="Total" strong>
                {formatPrice(Number(invoice.total), invoice.currency)}
              </Row>
              <Row label="Paid">
                {formatPrice(Number(invoice.amount_paid), invoice.currency)}
              </Row>
              <Row label="Owed" strong>
                {formatPrice(owed, invoice.currency)}
              </Row>
            </dl>

            {/*
              Said outright, under the figure it follows from. "Owed $0.00" is
              arithmetic somebody has to read; "Paid in full" is the answer they
              were reading it for. Green because it is good news and the only
              green on the card.
            */}
            {paidInFull && (
              <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-center text-sm font-semibold text-emerald-700">
                Paid in full
                {owed < 0 && (
                  <span className="block text-xs font-normal text-emerald-600">
                    Overpaid by {formatPrice(-owed, invoice.currency)}
                  </span>
                )}
              </p>
            )}

            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
              Paid comes from the ledger and nowhere else — there is no way to mark this settled
              without a payment on it.
            </p>
          </Section>

          {/* The order's Record card, and the same two facts on it. */}
          {/* The same card a sales order carries, saying what an invoice
              stores: it has a created_by and no updated_by of its own. */}
          {/* Every change, not just the last one — the same card a sales
              order carries. See 20260272000000. */}
          <Section title="Record history">
            <RecordHistory rows={history} currency={invoice.currency} lookups={lookups} />
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
