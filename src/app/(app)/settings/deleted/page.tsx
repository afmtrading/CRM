import Link from 'next/link'

import { requireAdmin, scoped } from '@/lib/tenancy'
import { contactName, formatCurrency } from '@/lib/format'
import { DateTime } from '@/components/date-time'
import type { CompanyRow, ContactRow, ProductRow, UserRow } from '@/lib/database.types'
import { EmptyState, PageHeader, Section } from '@/components/ui'

import { restoreCompany, restoreContact, restoreProduct } from '../actions'

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

  const [{ data: contacts }, { data: companies }, { data: products }, { data: users }] =
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
      scoped(context, 'users').select('*'),
    ])

  const contactRows = (contacts ?? []) as ContactRow[]
  const companyRows = (companies ?? []) as CompanyRow[]
  const productRows = (products ?? []) as ProductRow[]
  const userList = (users ?? []) as UserRow[]

  const deleterName = (id: string | null) => {
    if (!id) return 'Unknown'
    const user = userList.find((candidate) => candidate.id === id)
    return user ? user.name || user.email : 'Unknown'
  }

  const total = contactRows.length + companyRows.length + productRows.length

  return (
    <>
      <PageHeader
        title="Deleted records"
        description="Deleted records. Restoring puts one back where it was, with its owner, activities and deals intact. A deleted product stays readable on the deals that already list it, so their totals never move."
      />

      {total === 0 ? (
        <EmptyState
          title="Nothing has been deleted"
          description="When someone deletes a contact, a company or a product it lands here, and every administrator is notified."
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
        </div>
      )}
    </>
  )
}
