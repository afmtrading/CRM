import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { todayIn } from '@/lib/timezone'
import { formatDay, formatNumber } from '@/lib/format'
import { INVOICE_STATUS_LABELS, daysOverdue, isOverdue, summariseInvoices } from '@/lib/sales'
import type { CompanyRow, InvoiceRow, InvoiceStatus } from '@/lib/database.types'
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
              Purchase orders
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
          <select id="company" name="company" className="input" defaultValue={companyId}>
            <option value="">Every company</option>
            {companyList.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
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
                  <th>Channel</th>
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
                      {/* A marketplace is a company, so the same lookup names it —
                          the link goes to the channel rather than the account. */}
                      <td>
                        {invoice.marketplace_id ? (
                          <Link
                            href={`/marketplaces/${invoice.marketplace_id}`}
                            className="text-brand-700 hover:underline"
                          >
                            {companyName.get(invoice.marketplace_id) ?? 'Marketplace'}
                          </Link>
                        ) : (
                          <span className="text-xs text-slate-400">Direct</span>
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
