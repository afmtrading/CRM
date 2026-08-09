import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import { contactName, formatCurrency, formatNumber } from '@/lib/format'
import { PRODUCT_CARDS, renderMarkdown } from '@/lib/field-options'
import type {
  CustomFieldDefinitionRow,
  DealProductRow,
  FieldOptionRow,
  ProductRow,
} from '@/lib/database.types'
import { CustomFieldValues, Empty, Field, OptionBadges } from '@/components/contact-cards'
import { DealStatusBadge, EmptyState, PageHeader, Section } from '@/components/ui'

import { deleteProduct } from '../actions'

type LineItem = DealProductRow & {
  deals: {
    id: string
    name: string
    status: 'open' | 'won' | 'lost'
    currency: string
    probability: number
    companies: { id: string; name: string } | null
  } | null
}

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const product = await firstRow<ProductRow>(
    scoped(context, 'products').select('*').eq('id', id).maybeSingle(),
  )

  if (!product) notFound()

  const [{ data: lines }, { data: interest }, { data: customFields }, { data: fieldOptions }] =
    await Promise.all([
      scoped(context, 'deal_products')
        .select('*, deals(id, name, status, currency, probability, companies(id, name))')
        .eq('product_id', id)
        .order('created_at', { ascending: false })
        .limit(200),
      scoped(context, 'contact_products')
        .select('contact_id, contacts(id, first_name, last_name, email)')
        .eq('product_id', id)
        .limit(100),
      scoped(context, 'custom_field_definitions')
        .select('*')
        .eq('entity_type', 'product')
        .order('order'),
      scoped(context, 'field_options').select('*').eq('entity_type', 'product').order('order'),
    ])

  const lineItems = ((lines ?? []) as LineItem[]).filter((line) => line.deals !== null)
  const interestedContacts = (
    (interest ?? []) as {
      contacts: { id: string; first_name: string; last_name: string; email: string | null } | null
    }[]
  )
    .map((row) => row.contacts)
    .filter((contact): contact is NonNullable<typeof contact> => contact !== null)

  const fields = (customFields ?? []) as CustomFieldDefinitionRow[]
  const options = (fieldOptions ?? []) as FieldOptionRow[]
  const forCard = (card: string) => fields.filter((field) => field.card === card)

  // Totals are kept per currency for the same reason the report is: adding CAD
  // to EUR produces a number nobody can use.
  const totals = new Map<string, { open: number; won: number; quantity: number }>()
  for (const line of lineItems) {
    const currency = line.deals!.currency
    const entry = totals.get(currency) ?? { open: 0, won: 0, quantity: 0 }
    if (line.deals!.status === 'open') entry.open += Number(line.line_total)
    if (line.deals!.status === 'won') entry.won += Number(line.line_total)
    entry.quantity += Number(line.quantity)
    totals.set(currency, entry)
  }

  const price = Number(product.unit_price)
  const margin = price - Number(product.unit_cost)

  return (
    <>
      <PageHeader
        title={product.name}
        description={[product.sku, product.category, product.active ? null : 'Retired']
          .filter(Boolean)
          .join(' · ')}
        actions={
          context.canManage ? (
            <>
              <Link href={`/products/${id}/edit`} className="btn-secondary">
                Edit
              </Link>
              <form action={deleteProduct}>
                <input type="hidden" name="id" value={id} />
                <button type="submit" className="btn-danger">
                  Delete
                </button>
              </form>
            </>
          ) : undefined
        }
      />

      {/* Cards sit to the right on a wide screen and lead on a narrow one. */}
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-3">
        <div className="order-2 space-y-5 lg:order-1 lg:col-span-2">
          <Section
            title="On deals"
            actions={
              <span className="text-xs text-slate-500">
                {lineItems.length} line item{lineItems.length === 1 ? '' : 's'}
              </span>
            }
          >
            {lineItems.length === 0 ? (
              <p className="text-sm text-slate-500">
                This product is not on any deal yet. Add it from a deal&rsquo;s Line items card.
              </p>
            ) : (
              <>
                <div className="mb-4 flex flex-wrap gap-4">
                  {[...totals.entries()].map(([currency, entry]) => (
                    <div key={currency} className="rounded-xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-500">{currency}</p>
                      <p className="mt-1 text-sm text-slate-800">
                        <span className="font-semibold">{formatCurrency(entry.won, currency)}</span>{' '}
                        won
                        <span className="mx-2 text-slate-300">·</span>
                        {formatCurrency(entry.open, currency)} open
                      </p>
                      <p className="text-xs text-slate-500">
                        {formatNumber(entry.quantity)} {product.unit || 'units'}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Deal</th>
                        <th>Client</th>
                        <th className="text-right">Qty</th>
                        <th className="text-right">Price</th>
                        <th className="text-right">Total</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.map((line) => (
                        <tr key={line.id}>
                          <td>
                            <Link
                              href={`/deals/${line.deals!.id}`}
                              className="font-medium text-slate-900 hover:text-brand-700"
                            >
                              {line.deals!.name}
                            </Link>
                          </td>
                          <td className="text-slate-600">
                            {line.deals!.companies ? (
                              <Link
                                href={`/companies/${line.deals!.companies.id}`}
                                className="hover:text-brand-700"
                              >
                                {line.deals!.companies.name}
                              </Link>
                            ) : (
                              <Empty />
                            )}
                          </td>
                          <td className="text-right text-slate-700">
                            {formatNumber(Number(line.quantity))}
                          </td>
                          <td className="text-right text-slate-600">
                            {formatCurrency(Number(line.unit_price), line.deals!.currency)}
                          </td>
                          <td className="text-right font-medium text-slate-900">
                            {formatCurrency(Number(line.line_total), line.deals!.currency)}
                          </td>
                          <td>
                            <DealStatusBadge status={line.deals!.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Section>

          <Section title="Interested contacts">
            {interestedContacts.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nobody has been marked as interested. Set it on a contact&rsquo;s Influence card.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {interestedContacts.map((contact) => (
                  <li key={contact.id}>
                    <Link
                      href={`/contacts/${contact.id}`}
                      className="badge bg-slate-100 text-slate-700 hover:bg-slate-200"
                    >
                      {contactName(contact)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="order-1 space-y-5 lg:order-2">
          <Section title={PRODUCT_CARDS[0].label}>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="SKU">{product.sku || <Empty />}</Field>
              <Field label="Unit">{product.unit || <Empty />}</Field>
              <Field label="Category" wide>
                <OptionBadges
                  values={product.category ? [product.category] : []}
                  options={options.filter((option) => option.field_key === 'product_category')}
                />
              </Field>
              <Field label="Status">
                <span
                  className={`badge ${
                    product.active
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {product.active ? 'Active' : 'Retired'}
                </span>
              </Field>
              <CustomFieldValues
                fields={forCard('details')}
                values={product.custom_fields}
                fieldOptions={options}
              />
            </dl>
          </Section>

          <Section title={PRODUCT_CARDS[1].label}>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Price">{formatCurrency(price, product.currency)}</Field>
              <Field label="Cost">
                {formatCurrency(Number(product.unit_cost), product.currency)}
              </Field>
              <Field label="Margin">
                <span className={margin < 0 ? 'text-red-600' : undefined}>
                  {formatCurrency(margin, product.currency)}
                  {price > 0 && (
                    <span className="ml-2 text-xs text-slate-500">
                      {Math.round((margin / price) * 100)}%
                    </span>
                  )}
                </span>
              </Field>
              <Field label="Currency">{product.currency}</Field>
              <CustomFieldValues
                fields={forCard('pricing')}
                values={product.custom_fields}
                fieldOptions={options}
              />
            </dl>
          </Section>

          <Section title={PRODUCT_CARDS[2].label}>
            <dl className="grid gap-3">
              <Field label="Description" wide>
                {product.description ? (
                  <div
                    className="space-y-2 leading-relaxed text-slate-700"
                    // Safe by construction: renderMarkdown escapes the stored
                    // text before applying formatting, so the only markup here
                    // is what it generated.
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(product.description) }}
                  />
                ) : (
                  <Empty />
                )}
              </Field>
              <CustomFieldValues
                fields={forCard('additional')}
                values={product.custom_fields}
                fieldOptions={options}
              />
            </dl>
          </Section>
        </div>
      </div>

      {lineItems.length === 0 && interestedContacts.length === 0 && !product.active && (
        <div className="mt-5">
          <EmptyState
            title="Nothing refers to this product"
            description="It can be deleted outright from the recycle bin once removed."
          />
        </div>
      )}
    </>
  )
}
