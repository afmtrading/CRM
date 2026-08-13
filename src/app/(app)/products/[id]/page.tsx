import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import { contactName, formatCurrency, formatNumber, formatPrice } from '@/lib/format'
import { PRODUCT_CARDS, renderMarkdown, safeUrl } from '@/lib/field-options'
import type {
  CustomFieldDefinitionRow,
  DealProductRow,
  FieldOptionRow,
  ProductRow,
  StockAdjustmentRow,
  StockLevelRow,
} from '@/lib/database.types'
import { availableTone, formatDelta, formatQuantity } from '@/lib/stock'
import { productImageUrl } from '@/lib/product-image'
import {
  type DerivedPrice,
  derivePricing,
  showroomMargin,
  wholesaleMargin,
} from '@/lib/products'
import {
  CustomFieldValues,
  Empty,
  ExternalLink,
  Field,
  OptionBadges,
} from '@/components/contact-cards'
import { DealStatusBadge, EmptyState, PageHeader, Section } from '@/components/ui'
import { DateTime } from '@/components/date-time'

import { deleteProduct } from '../actions'

/**
 * One price, and whether anybody chose it.
 *
 * A worked-out price is shown in grey next to a typed one in black, because a
 * price list where the two are indistinguishable invites somebody to quote a
 * number the app invented as though a person had agreed to it.
 */
function PriceCell({ price, currency }: { price: DerivedPrice; currency: string }) {
  if (price.value === null) return <span className="text-slate-300">—</span>

  return (
    <span
      className={price.auto ? 'text-slate-500' : 'font-medium text-slate-900'}
      title={price.auto ? 'Worked out — nobody has set this one' : 'Set by hand'}
    >
      {formatPrice(price.value, currency)}
    </span>
  )
}

/** One of the four headline stock numbers. */
function StockTile({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: string
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-center">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${tone ?? 'text-slate-900'}`}>
        {formatQuantity(value)}
      </p>
    </div>
  )
}

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

  const [
    { data: lines },
    { data: interest },
    { data: customFields },
    { data: fieldOptions },
    { data: levels },
    { data: movements },
    { data: stockSummary },
  ] = await Promise.all([
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
      scoped(context, 'stock_levels')
        .select('*, stock_locations(name, code), stock_bins(name)')
        .eq('product_id', id),
      scoped(context, 'stock_adjustments')
        .select('*, stock_locations(name), stock_bins(name), users:created_by(name)')
        .eq('product_id', id)
        .order('created_at', { ascending: false })
        .limit(50),
      context.supabase.rpc('product_stock_summary', { p_product_id: id }),
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

  // Six of the price columns are null unless somebody typed into them; this is
  // what turns those holes back into a price list. See src/lib/products.ts.
  const pricing = derivePricing(product)
  const showroom = showroomMargin(product)
  const wholesale = wholesaleMargin(product)
  const currency = product.currency

  type LevelWithPlace = StockLevelRow & {
    stock_locations: { name: string; code: string | null } | null
    stock_bins: { name: string } | null
  }
  type MovementRow = StockAdjustmentRow & {
    stock_locations: { name: string } | null
    stock_bins: { name: string } | null
    users: { name: string } | null
  }

  const stockLevels = (levels ?? []) as LevelWithPlace[]
  const stockMovements = (movements ?? []) as MovementRow[]

  // The summary is the authority on all four numbers — committed in particular,
  // which is read off open deals the page cannot see through its own policies.
  const stock = ((stockSummary ?? [])[0] ?? {
    on_hand: 0,
    committed: 0,
    reserved: 0,
    available: 0,
  }) as { on_hand: number; committed: number; reserved: number; available: number }

  const imageUrl = productImageUrl(product.image_path)

  const marketLinks = [
    { label: 'Barcode Lookup', url: safeUrl(product.barcode_url) },
    { label: 'Comp 1', url: safeUrl(product.comp_1_url) },
    { label: 'Comp 2', url: safeUrl(product.comp_2_url) },
  ]

  return (
    <>
      <PageHeader
        title={product.name}
        description={[product.brand, product.sku, product.category, product.status]
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
          <Section title={PRODUCT_CARDS[0].label}>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Field label="SKU">{product.sku || <Empty />}</Field>
              <Field label="Brand">{product.brand || <Empty />}</Field>
              <Field label="Model">{product.model || <Empty />}</Field>
              <Field label="Count">{product.item_count || <Empty />}</Field>
              <Field label="Size">{product.size || <Empty />}</Field>
              <Field label="Color">{product.color || <Empty />}</Field>
              <Field label="Case Pack">
                {product.case_pack === null ? <Empty /> : formatNumber(product.case_pack)}
              </Field>
              <Field label="Product Type">
                <OptionBadges
                  values={product.product_type ? [product.product_type] : []}
                  options={options.filter((option) => option.field_key === 'product_type')}
                />
              </Field>
              <Field label="Condition">
                <OptionBadges
                  values={product.product_condition ? [product.product_condition] : []}
                  options={options.filter((option) => option.field_key === 'product_condition')}
                />
              </Field>
              <Field label="Status">
                <OptionBadges
                  values={product.status ? [product.status] : []}
                  options={options.filter((option) => option.field_key === 'product_status')}
                />
              </Field>
              <Field label="Category" wide>
                <OptionBadges
                  values={product.category ? [product.category] : []}
                  options={options.filter((option) => option.field_key === 'product_category')}
                />
              </Field>
              <Field label="Item Notes" wide>
                {product.item_notes ? (
                  <div
                    className="space-y-2 leading-relaxed text-slate-700"
                    // Safe by construction: renderMarkdown escapes the stored
                    // text before applying formatting, so the only markup here
                    // is what it generated.
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(product.item_notes) }}
                  />
                ) : (
                  <Empty />
                )}
              </Field>
              <CustomFieldValues
                fields={forCard('details')}
                values={product.custom_fields}
                fieldOptions={options}
              />
            </dl>
          </Section>

          <Section
            title="Pricing"
            actions={
              <span className="text-xs text-slate-500">
                {currency}
                <span className="mx-2 text-slate-300">·</span>
                showroom{' '}
                <span className={showroom.amount < 0 ? 'text-red-600' : undefined}>
                  {formatPrice(showroom.amount, currency)}
                  {showroom.percent !== null && ` (${showroom.percent}%)`}
                </span>
                <span className="mx-2 text-slate-300">·</span>
                wholesale{' '}
                <span className={wholesale.amount < 0 ? 'text-red-600' : undefined}>
                  {formatPrice(wholesale.amount, currency)}
                  {wholesale.percent !== null && ` (${wholesale.percent}%)`}
                </span>
              </span>
            }
          >
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th />
                    <th className="text-right">Retail</th>
                    <th className="text-right">Showroom</th>
                    <th className="text-right">Wholesale</th>
                    <th className="text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" className="text-left font-medium text-slate-700">
                      Unit
                    </th>
                    <td className="text-right">
                      <PriceCell price={pricing.unit.retail} currency={currency} />
                    </td>
                    <td className="text-right">
                      <PriceCell price={pricing.unit.showroom} currency={currency} />
                    </td>
                    <td className="text-right">
                      <PriceCell price={pricing.unit.wholesale} currency={currency} />
                    </td>
                    <td className="text-right">
                      <PriceCell price={pricing.unit.cost} currency={currency} />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="text-left font-medium text-slate-700">
                      Piece
                    </th>
                    <td className="text-right">
                      <PriceCell price={pricing.piece.retail} currency={currency} />
                    </td>
                    <td className="text-right">
                      <PriceCell price={pricing.piece.showroom} currency={currency} />
                    </td>
                    <td className="text-right">
                      <PriceCell price={pricing.piece.wholesale} currency={currency} />
                    </td>
                    <td className="text-right">
                      <PriceCell price={pricing.piece.cost} currency={currency} />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="text-left font-medium text-slate-700">
                      Pallet
                    </th>
                    <td className="text-right">
                      <PriceCell price={pricing.pallet.retail} currency={currency} />
                    </td>
                    <td className="text-right text-slate-300">—</td>
                    <td className="text-right">
                      <PriceCell price={pricing.pallet.wholesale} currency={currency} />
                    </td>
                    <td className="text-right">
                      <PriceCell price={pricing.pallet.cost} currency={currency} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-slate-400">
              Grey prices are worked out rather than agreed: showroom is 70% of retail, wholesale is
              30%, and a piece is a unit divided by the case pack
              {pricing.casePack === null
                ? ' — which is not set, so there are no piece prices yet.'
                : ` of ${formatNumber(pricing.casePack)}.`}{' '}
              Type over any of them to fix a price; clear the box to hand it back.
            </p>
          </Section>

          <Section
            title="Stock"
            actions={
              context.canManage ? (
                <Link href={`/products/${id}/edit`} className="text-xs text-brand-700 hover:underline">
                  Adjust
                </Link>
              ) : undefined
            }
          >
            <div className="mb-4 grid gap-3 sm:grid-cols-4">
              <StockTile label="On Hand" value={stock.on_hand} />
              <StockTile label="Committed" value={stock.committed} tone="text-amber-600" />
              <StockTile label="Reserved" value={stock.reserved} tone="text-amber-600" />
              <StockTile
                label="Available"
                value={stock.available}
                tone={availableTone(Number(stock.available))}
              />
            </div>

            {stockLevels.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nothing counted yet. Add a location and a quantity on the product&rsquo;s Stock card.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th>Bin</th>
                      <th className="text-right">On hand</th>
                      <th className="text-right">Reserved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockLevels.map((level) => (
                      <tr key={level.id}>
                        <td className="font-medium text-slate-800">
                          {level.stock_locations?.name ?? <Empty />}
                          {level.stock_locations?.code && (
                            <span className="ml-2 text-xs text-slate-400">
                              {level.stock_locations.code}
                            </span>
                          )}
                        </td>
                        <td className="text-slate-600">{level.stock_bins?.name ?? '—'}</td>
                        <td className="text-right font-medium text-slate-900">
                          {formatQuantity(level.quantity)}
                        </td>
                        <td className="text-right text-slate-600">
                          {Number(level.reserved) > 0 ? formatQuantity(level.reserved) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="mt-3 text-xs text-slate-400">
              Committed is what open deals have already asked for — it follows the line items rather
              than being entered here. Available can go negative, which means more has been promised
              than exists.
            </p>
          </Section>

          {stockMovements.length > 0 && (
            <Section
              title="Stock history"
              actions={
                <span className="text-xs text-slate-500">
                  {stockMovements.length} movement{stockMovements.length === 1 ? '' : 's'}
                </span>
              }
            >
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Where</th>
                      <th className="text-right">Change</th>
                      <th className="text-right">After</th>
                      <th>Why</th>
                      <th>Who</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockMovements.map((movement) => (
                      <tr key={movement.id}>
                        <td className="whitespace-nowrap text-slate-600">
                          <DateTime value={movement.created_at} />
                        </td>
                        <td className="text-slate-600">
                          {movement.stock_locations?.name ?? 'A former location'}
                          {movement.stock_bins?.name && (
                            <span className="text-slate-400"> · {movement.stock_bins.name}</span>
                          )}
                          {movement.field === 'reserved' && (
                            <span className="badge ml-2 bg-amber-100 text-amber-800">reserved</span>
                          )}
                        </td>
                        <td
                          className={`text-right font-medium ${
                            Number(movement.delta) < 0 ? 'text-red-600' : 'text-emerald-700'
                          }`}
                        >
                          {formatDelta(movement.delta)}
                        </td>
                        <td className="text-right text-slate-600">
                          {formatQuantity(movement.quantity_after)}
                        </td>
                        <td className="text-slate-600">{movement.reason ?? <Empty />}</td>
                        <td className="text-slate-600">{movement.users?.name ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

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
                        {formatNumber(entry.quantity)} units
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
        </div>

        <div className="order-1 space-y-5 lg:order-2">
          {(imageUrl || product.folder_url || product.knowledge_base_url) && (
            /* No heading: a picture announces itself, and the two links under it
               are about where to find more of the same thing. */
            <section className="card space-y-4 p-5">
              {imageUrl && (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a
                      storage URL, which next/image would need a remote pattern
                      for and which is already sized for the web on the way in. */}
                  <img
                    src={imageUrl}
                    alt={product.name}
                    className="mx-auto max-h-64 w-auto rounded-lg object-contain"
                  />
                </>
              )}

              <dl className="grid gap-3">
                <Field label="Folder Location">
                  <ExternalLink url={safeUrl(product.folder_url)} />
                </Field>
                <Field label="Knowledge Base">
                  <ExternalLink url={safeUrl(product.knowledge_base_url)} />
                </Field>
              </dl>
            </section>
          )}

          <Section title="In the Market">
            {marketLinks.every((link) => link.url === null) ? (
              <p className="text-sm text-slate-500">
                No comparisons saved. Add a barcode lookup or a competitor&rsquo;s listing when
                editing the product.
              </p>
            ) : (
              <dl className="grid gap-3 sm:grid-cols-3">
                {marketLinks.map((link) => (
                  <Field key={link.label} label={link.label}>
                    <ExternalLink url={link.url} />
                  </Field>
                ))}
              </dl>
            )}
          </Section>

          {forCard('pricing').length > 0 && (
            <Section title={PRODUCT_CARDS[1].label}>
              <dl className="grid gap-3 sm:grid-cols-2">
                <CustomFieldValues
                  fields={forCard('pricing')}
                  values={product.custom_fields}
                  fieldOptions={options}
                />
              </dl>
            </Section>
          )}

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
