import Link from 'next/link'

import { requireAdmin, scoped } from '@/lib/tenancy'
import { contactName, formatCurrency, formatDay } from '@/lib/format'
import { DateTime } from '@/components/date-time'
import type {
  CompanyRow,
  ContactRow,
  DealRow,
  ProductRow,
  SalesOrderRow,
  UserRow,
} from '@/lib/database.types'
import {
  DealStatusBadge,
  EmptyState,
  PageHeader,
  SalesOrderStatusBadge,
  Section,
} from '@/components/ui'

import {
  restoreCompany,
  restoreContact,
  restoreDeal,
  restoreProduct,
  restoreSalesOrder,
} from '../actions'

export const metadata = { title: 'Deleted records · FLO CRM' }

/**
 * The recycle bin.
 *
 * Deleting a contact or company stamps it rather than destroying it: it leaves
 * every other role's view, and this page is the only place it can be seen or
 * brought back. Administrators are notified whenever something lands here.
 */
export default async function DeletedRecordsPage() {
  const context = await requireAdmin()

  const [
    { data: contacts },
    { data: companies },
    { data: products },
    { data: deals },
    { data: salesOrders },
    { data: users },
  ] =
    await Promise.all([
      scoped(context, 'contacts')
        .select('*')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })
        .limit(200),
      scoped(context, 'companies')
        .select('*')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })
        .limit(200),
      scoped(context, 'products')
        .select('*')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })
        .limit(200),
      scoped(context, 'deals')
        .select('*, stages(name)')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })
        .limit(200),
      scoped(context, 'sales_orders')
        .select('*')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })
        .limit(200),
      scoped(context, 'users').select('*'),
    ])

  const contactRows = (contacts ?? []) as ContactRow[]
  const companyRows = (companies ?? []) as CompanyRow[]
  const productRows = (products ?? []) as ProductRow[]
  const dealRows = (deals ?? []) as (DealRow & { stages: { name: string } | null })[]
  const salesOrderRows = (salesOrders ?? []) as SalesOrderRow[]
  const userList = (users ?? []) as UserRow[]

  const deleterName = (id: string | null) => {
    if (!id) return 'Unknown'
    const user = userList.find((candidate) => candidate.id === id)
    return user ? user.name || user.email : 'Unknown'
  }

  const total =
    contactRows.length +
    companyRows.length +
    productRows.length +
    dealRows.length +
    salesOrderRows.length

  return (
    <>
      <PageHeader
        title="Deleted records"
        description="Deleted records. Restoring puts one back where it was, with its owner, activities and deals intact. A deleted product stays readable on the deals that already list it, so their totals never move — and a deleted deal keeps its line items, so restoring it recommits the stock it had spoken for."
      />

      {total === 0 ? (
        <EmptyState
          title="Nothing has been deleted"
          description="When someone deletes a contact, a company, a product, a deal or a sales order it lands here, and every administrator is notified."
        />
      ) : (
        <div className="space-y-5">
          {contactRows.length > 0 && (
            <Section title={`Contacts (${contactRows.length})`}>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Deleted by</th>
                      <th>Deleted</th>
                      <th className="text-right">Restore</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contactRows.map((contact) => {
                      const name = contactName(contact)
                      return (
                        <tr key={contact.id}>
                          <td>
                            <div className="flex items-center gap-3">
                              <Link
                                href={`/contacts/${contact.id}`}
                                className="font-medium text-slate-900 hover:text-brand-700"
                              >
                                {name}
                              </Link>
                            </div>
                          </td>
                          <td className="text-slate-600">{contact.email ?? '—'}</td>
                          <td className="text-slate-600">{deleterName(contact.deleted_by)}</td>
                          <td className="text-slate-500"><DateTime value={contact.deleted_at} /></td>
                          <td className="text-right">
                            <form action={restoreContact}>
                              <input type="hidden" name="id" value={contact.id} />
                              <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
                                Restore
                              </button>
                            </form>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {companyRows.length > 0 && (
            <Section title={`Companies (${companyRows.length})`}>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Website</th>
                      <th>Deleted by</th>
                      <th>Deleted</th>
                      <th className="text-right">Restore</th>
                    </tr>
                  </thead>
                  <tbody>
                    {companyRows.map((company) => (
                      <tr key={company.id}>
                        <td>
                          <div className="flex items-center gap-3">
                            <Link
                              href={`/companies/${company.id}`}
                              className="font-medium text-slate-900 hover:text-brand-700"
                            >
                              {company.name}
                            </Link>
                          </div>
                        </td>
                        <td className="text-slate-600">{company.domain ?? '—'}</td>
                        <td className="text-slate-600">{deleterName(company.deleted_by)}</td>
                        <td className="text-slate-500"><DateTime value={company.deleted_at} /></td>
                        <td className="text-right">
                          <form action={restoreCompany}>
                            <input type="hidden" name="id" value={company.id} />
                            <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
                              Restore
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
          {/*
            Deals first among the record types below: a deleted deal is the one
            that takes numbers with it — stock it had committed, the pipeline it
            was part of — so it is the one somebody is most likely here to undo.
          */}
          {dealRows.length > 0 && (
            <Section title={`Deals (${dealRows.length})`}>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Deal</th>
                      <th>Stage</th>
                      <th>Status</th>
                      <th className="text-right">Value</th>
                      <th>Expected close</th>
                      <th>Deleted by</th>
                      <th>Deleted</th>
                      <th className="text-right">Restore</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dealRows.map((deal) => (
                      <tr key={deal.id}>
                        <td>
                          <Link
                            href={`/deals/${deal.id}`}
                            className="font-medium text-slate-900 hover:text-brand-700"
                          >
                            {deal.name}
                          </Link>
                        </td>
                        <td className="text-slate-600">{deal.stages?.name ?? '—'}</td>
                        <td>
                          <DealStatusBadge status={deal.status} />
                        </td>
                        <td className="text-right text-slate-600">
                          {formatCurrency(Number(deal.value), deal.currency)}
                        </td>
                        <td className="text-slate-500">{formatDay(deal.expected_close_date)}</td>
                        <td className="text-slate-600">{deleterName(deal.deleted_by)}</td>
                        <td className="text-slate-500"><DateTime value={deal.deleted_at} /></td>
                        <td className="text-right">
                          <form action={restoreDeal}>
                            <input type="hidden" name="id" value={deal.id} />
                            <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
                              Restore
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {productRows.length > 0 && (
            <Section title={`Products (${productRows.length})`}>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>SKU</th>
                      <th className="text-right">Price</th>
                      <th>Deleted by</th>
                      <th>Deleted</th>
                      <th className="text-right">Restore</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productRows.map((product) => (
                      <tr key={product.id}>
                        <td>
                          <Link
                            href={`/products/${product.id}`}
                            className="font-medium text-slate-900 hover:text-brand-700"
                          >
                            {product.name}
                          </Link>
                        </td>
                        <td className="text-slate-600">{product.sku ?? '—'}</td>
                        <td className="text-right text-slate-600">
                          {formatCurrency(Number(product.unit_price), product.currency)}
                        </td>
                        <td className="text-slate-600">{deleterName(product.deleted_by)}</td>
                        <td className="text-slate-500"><DateTime value={product.deleted_at} /></td>
                        <td className="text-right">
                          <form action={restoreProduct}>
                            <input type="hidden" name="id" value={product.id} />
                            <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
                              Restore
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {salesOrderRows.length > 0 && (
            <Section title={`Sales orders (${salesOrderRows.length})`}>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Number</th>
                      <th>Status</th>
                      <th>Date</th>
                      <th>Deleted by</th>
                      <th>Deleted</th>
                      <th className="text-right">Restore</th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesOrderRows.map((order) => (
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
                        <td className="text-slate-600">{formatDay(order.order_date)}</td>
                        <td className="text-slate-600">{deleterName(order.deleted_by)}</td>
                        <td className="text-slate-500"><DateTime value={order.deleted_at} /></td>
                        <td className="text-right">
                          <form action={restoreSalesOrder}>
                            <input type="hidden" name="id" value={order.id} />
                            <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
                              Restore
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </div>
      )}
    </>
  )
}
