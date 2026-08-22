import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { todayIn } from '@/lib/timezone'
import { formatDay, formatNumber } from '@/lib/format'
import { INVOICE_STATUS_LABELS, daysOverdue, isOverdue, summariseInvoices } from '@/lib/sales'
import type { CompanyRow, InvoiceRow, InvoiceStatus } from '@/lib/database.types'
import { CompanyFilter } from '@/app/(app)/sales-orders/company-filter'
import { MoneyTotals } from '@/components/money'
import { EmptyState, ErrorNote, InvoiceStatusBadge, PageHeader } from '@/components/ui'

import { createInvoice } from './actions'

export const metadata = { title: 'Invoices · FLO CRM' }

export const dynamic = 'force-dynamic'

const STATUSES: InvoiceStatus[] = ['draft', 'sent', 'partial', 'paid', 'void']

/**
 * Invoices.
 *
 * An invoice is a snapshot of what was billed, so this list is a record rather
 * than a working area — the only number on it that moves is what is still owed,
 * and that moves because a payment landed.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const context = await requireSession()

  const status = (Array.isArray(params.status) ? params.status[0] : params.status) ?? 'all'
  const companyId = (Array.isArray(params.company) ? params.company[0] : params.company) ?? ''
  const overdueOnly = (Array.isArray(params.due) ? params.due[0] : params.due) === 'overdue'
  const today = todayIn(context.organization.timezone)

  let query = scoped(context, 'invoices')
    .select('*')
    .order('issue_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500)

  if ((STATUSES as string[]).includes(status)) query = query.eq('status', status)
  if (companyId) query = query.eq('company_id', companyId)

  /*
   * Two columns, and alongside the invoices rather than in front of them.
   * Companies are here to name an id and fill the filter dropdown; selecting *
   * dragged every jsonb and array column of the whole book across to do it, and
   * awaiting it first made the invoice query wait for that.
   */
  const [{ data, error }, { data: companies }] = await Promise.all([
    query,
    scoped(context, 'companies').select('id, name').is('deleted_at', null).order('name'),
  ])
  const all = (data ?? []) as InvoiceRow[]
  const invoices = overdueOnly ? all.filter((invoice) => isOverdue(invoice, today)) : all

  /*
   * Who moves the goods, for the Delivery column.
   *
   * An invoice has no shipping columns of its own — it is carried from the
   * order, the same way the detail page carries it — so this is one query for
   * the orders behind the whole page rather than one per row. Skipped entirely
   * when nothing on the page came from an order.
   */
  const orderIds = [
    ...new Set(invoices.map((invoice) => invoice.sales_order_id).filter(Boolean) as string[]),
  ]
  const { data: orderRows } =
    orderIds.length > 0
      ? await scoped(context, 'sales_orders')
          .select('id, shipping_responsibility')
          .in('id', orderIds)
      : { data: [] as { id: string; shipping_responsibility: string | null }[] }

  const deliveryByOrder = new Map(
    ((orderRows ?? []) as { id: string; shipping_responsibility: string | null }[]).map((one) => [
      one.id,
      one.shipping_responsibility,
    ]),
  )
  const deliveryFor = (invoice: InvoiceRow) =>
    invoice.sales_order_id ? (deliveryByOrder.get(invoice.sales_order_id) ?? null) : null

  const summary = summariseInvoices(invoices, today)
  const companyList = (companies ?? []) as Pick<CompanyRow, 'id' | 'name'>[]
  const companyName = new Map(companyList.map((company) => [company.id, company.name]))

  return (
    <>
      <PageHeader
        title="Invoices"
        actions={
          <>
            <Link href="/sales-orders" className="btn-secondary">
              Sales orders
            </Link>
            {/* An invoice does not need an order behind it. Raising one lands on
                a draft that can be built up and then issued. */}
            {context.canWrite && (
              <form action={createInvoice}>
                <button type="submit" className="btn-primary">
                  New invoice
                </button>
              </form>
            )}
          </>
        }
      />

      {error && <ErrorNote>{error.message}</ErrorNote>}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Invoices">
          <span className="text-xl font-semibold text-slate-900">
            {formatNumber(summary.count)}
          </span>
          <span className="mt-0.5 block text-xs text-slate-500">On this view</span>
        </Tile>

        <Tile label="Billed">
          <MoneyTotals rows={summary.billed} amountClassName="text-xl font-semibold text-slate-900" />
          <span className="mt-0.5 block text-xs text-slate-500">Void invoices excluded</span>
        </Tile>

        <Tile label="Paid">
          <MoneyTotals rows={summary.paid} amountClassName="text-xl font-semibold text-slate-900" />
          <span className="mt-0.5 block text-xs text-slate-500">From the payment ledgers</span>
        </Tile>

        <Tile label="Outstanding">
          <MoneyTotals
            rows={summary.outstanding}
            amountClassName="text-xl font-semibold text-slate-900"
          />
          <span className="mt-0.5 block text-xs text-slate-500">
            {summary.overdue > 0 ? `${formatNumber(summary.overdue)} past due` : 'None past due'}
          </span>
        </Tile>
      </div>

      <form className="card mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="status">
            Status
          </label>
          <select id="status" name="status" className="input" defaultValue={status}>
            <option value="all">Any status</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {INVOICE_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="company">
            Company
          </label>
          {/* The same combobox the sales order list uses. A plain select is
              fine at a dozen companies and unusable at three hundred — the
              browser's own type-ahead only matches from the first letter. */}
          <CompanyFilter companies={companyList} selected={companyId} />
        </div>

        <div>
          <label className="label" htmlFor="due">
            Due
          </label>
          <select id="due" name="due" className="input" defaultValue={overdueOnly ? 'overdue' : ''}>
            <option value="">Any</option>
            <option value="overdue">Past due, still owed</option>
          </select>
        </div>

        <div className="flex items-end gap-2">
          <button type="submit" className="btn-primary">
            Apply
          </button>
          <Link href="/invoices" className="btn-secondary">
            Clear
          </Link>
        </div>
      </form>

      {invoices.length === 0 ? (
        <EmptyState
          title="No invoices"
          description="Bill a confirmed sales order, or raise an invoice on its own with New invoice."
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Status</th>
                  <th>Company</th>
                  <th>Delivery</th>
                  <th>Issued</th>
                  <th>Due</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Owed</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => {
                  const owed = Number(invoice.total) - Number(invoice.amount_paid)
                  const late = daysOverdue(invoice.due_date, today)

                  return (
                    <tr key={invoice.id}>
                      <td>
                        <Link
                          href={`/invoices/${invoice.id}`}
                          className="font-medium text-slate-900 hover:text-brand-700"
                        >
                          {invoice.number}
                        </Link>
                      </td>
                      <td>
                        <InvoiceStatusBadge status={invoice.status} />
                      </td>
                      <td>
                        {invoice.company_id ? (
                          <Link
                            href={`/companies/${invoice.company_id}`}
                            className="text-brand-700 hover:underline"
                          >
                            {companyName.get(invoice.company_id) ?? 'Unknown'}
                          </Link>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      {/*
                        Who moves the goods, carried from the order that raised
                        this invoice. It showed the channel an invoice sold
                        through, which is on the record for anybody who needs it
                        and read Direct on almost every row — the same change the
                        sales order list made to the same column.
                      */}
                      <td>
                        {deliveryFor(invoice) ? (
                          <span className="text-slate-600">{deliveryFor(invoice)}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td>{formatDay(invoice.issue_date)}</td>
                      <td>
                        {invoice.due_date ? formatDay(invoice.due_date) : '—'}
                        {isOverdue(invoice, today) && (
                          <span className="ml-1.5 text-xs font-medium text-red-600">
                            {late}d late
                          </span>
                        )}
                      </td>
                      <td className="text-right">
                        <MoneyTotals
                          rows={[{ value: Number(invoice.total), currency: invoice.currency }]}
                        />
                      </td>
                      <td className="text-right">
                        {invoice.status === 'void' ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <MoneyTotals rows={[{ value: owed, currency: invoice.currency }]} />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}
