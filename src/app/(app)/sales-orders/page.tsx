import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatDay, formatNumber } from '@/lib/format'
import {
  SALES_ORDER_STATUSES,
  SALES_ORDER_STATUS_LABELS,
  documentDiscount,
  isSalesOrderFiltered,
  salesOrderFilterFromParams,
  totalsByCurrency,
} from '@/lib/sales'
import { likeContains } from '@/lib/sql'
import type { CompanyRow, SalesOrderRow, UserRow } from '@/lib/database.types'
import { MoneyTotals } from '@/components/money'
import { EmptyState, ErrorNote, PageHeader, SalesOrderStatusBadge } from '@/components/ui'

import { createSalesOrder } from './actions'
import { CompanyFilter } from './company-filter'

export const metadata = { title: 'Sales orders · FLO CRM' }

export const dynamic = 'force-dynamic'

/**
 * Sales orders.
 *
 * What customers have actually bought — separate from Deals on purpose, and
 * with no way to get from one to the other. See docs/SALES_ORDERS_INVOICES.md.
 */
export default async function SalesOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const context = await requireSession()
  const filter = salesOrderFilterFromParams(params)

  const [{ data: companies }, { data: users }] = await Promise.all([
    // Named, not whole. Both are here to turn an id into a name and to fill a
    // dropdown; `*` pulled every column of every company to do it.
    scoped(context, 'companies').select('id, name').is('deleted_at', null).order('name'),
    scoped(context, 'users').select('id, name, email').order('name'),
  ])

  let query = scoped(context, 'sales_orders')
    .select('*')
    .is('deleted_at', null)
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500)

  if (filter.status !== 'all') query = query.eq('status', filter.status)
  if (filter.company) query = query.eq('company_id', filter.company)
  if (filter.owner) query = query.eq('owner_id', filter.owner)
  if (filter.from) query = query.gte('order_date', filter.from)
  if (filter.to) query = query.lte('order_date', filter.to)
  if (filter.search) query = query.ilike('number', likeContains(filter.search))

  const { data, error } = await query
  const orders = (data ?? []) as SalesOrderRow[]

  // The line totals, in one query rather than one per order. Skipped entirely
  // when there is nothing to ask about — an `in ()` on an empty list is a
  // round trip for a known answer, and Postgres would reject the placeholder.
  const { data: lineRows } =
    orders.length > 0
      ? await scoped(context, 'sales_order_lines')
          .select('sales_order_id, line_total')
          .in('sales_order_id', orders.map((order) => order.id))
      : { data: [] as { sales_order_id: string; line_total: number }[] }

  const valueByOrder = new Map<string, number>()
  for (const line of lineRows ?? []) {
    valueByOrder.set(
      line.sales_order_id,
      (valueByOrder.get(line.sales_order_id) ?? 0) + Number(line.line_total),
    )
  }

  /*
   * What the order is worth, by the same rule the document prints: the lines,
   * less whatever was taken off the whole order, plus carriage. A list that
   * ignored the discount would total more than the invoices behind it.
   */
  const orderValue = (order: SalesOrderRow) => {
    const subtotal = valueByOrder.get(order.id) ?? 0
    const off = documentDiscount(
      subtotal,
      order.discount_type,
      order.discount_rate === null ? null : Number(order.discount_rate),
    )
    return subtotal - off + Number(order.shipping_charge)
  }

  const companyList = (companies ?? []) as Pick<CompanyRow, 'id' | 'name'>[]
  const companyName = new Map(companyList.map((company) => [company.id, company.name]))
  const ownerName = new Map(
    ((users ?? []) as Pick<UserRow, 'id' | 'name' | 'email'>[]).map((user) => [
      user.id,
      user.name || user.email,
    ]),
  )

  // Cancelled orders are not money anybody expects, so they stay out of the
  // total while remaining on the list — the same rule void invoices follow.
  const live = orders.filter((order) => order.status !== 'cancelled')
  const totals = totalsByCurrency(
    live.map((order) => ({ value: orderValue(order), currency: order.currency })),
  )

  return (
    <>
      <PageHeader
        title="Sales orders"
        actions={
          <>
            <Link href="/invoices" className="btn-secondary">
              Invoices
            </Link>
            {context.canWrite && (
              <form action={createSalesOrder}>
                <button type="submit" className="btn-primary">
                  New order
                </button>
              </form>
            )}
          </>
        }
      />

      {error && <ErrorNote>{error.message}</ErrorNote>}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Tile label="Orders">
          <span className="text-xl font-semibold text-slate-900">{formatNumber(orders.length)}</span>
          <span className="mt-0.5 block text-xs text-slate-500">
            {formatNumber(orders.filter((o) => o.status === 'draft').length)} draft ·{' '}
            {formatNumber(orders.filter((o) => o.status === 'reserved').length)} reserved
          </span>
        </Tile>

        <Tile label="Value">
          <MoneyTotals rows={totals} amountClassName="text-xl font-semibold text-slate-900" />
          <span className="mt-0.5 block text-xs text-slate-500">
            Lines plus shipping, cancelled orders excluded
          </span>
        </Tile>

        <Tile label="Ready to invoice">
          <span className="text-xl font-semibold text-slate-900">
            {formatNumber(orders.filter((o) => o.status === 'confirmed').length)}
          </span>
          <span className="mt-0.5 block text-xs text-slate-500">Confirmed and not yet billed</span>
        </Tile>
      </div>

      <form className="card mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Number" htmlFor="q">
          <input id="q" name="q" className="input" defaultValue={filter.search} placeholder="SO-" />
        </Field>

        <Field label="Status" htmlFor="status">
          <select id="status" name="status" className="input" defaultValue={filter.status}>
            <option value="all">Any status</option>
            {SALES_ORDER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {SALES_ORDER_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Company" htmlFor="company">
          <CompanyFilter companies={companyList} selected={filter.company} />
        </Field>

        <Field label="From" htmlFor="from">
          <input id="from" name="from" type="date" className="input" defaultValue={filter.from} />
        </Field>

        <Field label="To" htmlFor="to">
          <input id="to" name="to" type="date" className="input" defaultValue={filter.to} />
        </Field>

        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
          <button type="submit" className="btn-primary">
            Apply
          </button>
          {isSalesOrderFiltered(filter) && (
            <Link href="/sales-orders" className="btn-secondary">
              Clear
            </Link>
          )}
        </div>
      </form>

      {orders.length === 0 ? (
        <EmptyState
          title="No sales orders yet"
          description="An order records what a customer bought. It does not need a deal behind it."
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
                  <th>Shipping</th>
                  <th>Owner</th>
                  <th>Date</th>
                  <th className="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link
                        href={`/sales-orders/${order.id}`}
                        className="font-medium text-slate-900 hover:text-brand-700"
                      >
                        {order.number}
                      </Link>
                    </td>
                    <td>
                      <SalesOrderStatusBadge status={order.status} />
                    </td>
                    <td>
                      {order.company_id ? (
                        <Link
                          href={`/companies/${order.company_id}`}
                          className="text-brand-700 hover:underline"
                        >
                          {companyName.get(order.company_id) ?? 'Unknown'}
                        </Link>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    {/* Who moves the goods. This column showed the channel an
                        order sold through, which is on the record for anybody
                        who needs it and was Direct on almost every row. */}
                    <td>
                      {order.shipping_responsibility ? (
                        <span className="text-slate-600">{order.shipping_responsibility}</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td>{order.owner_id ? (ownerName.get(order.owner_id) ?? '—') : '—'}</td>
                    <td>{formatDay(order.order_date)}</td>
                    <td className="text-right">
                      <MoneyTotals
                        rows={[{ value: orderValue(order), currency: order.currency }]}
                      />
                    </td>
                  </tr>
                ))}
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

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}
