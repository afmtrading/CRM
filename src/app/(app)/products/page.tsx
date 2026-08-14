import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatNumber, formatPrice } from '@/lib/format'
import type { FieldOptionRow, ProductRow } from '@/lib/database.types'
import { derivePricing } from '@/lib/products'
import { availableTone, formatQuantity } from '@/lib/stock'
import { productImageUrl } from '@/lib/product-image'
import { likeContains } from '@/lib/sql'
import { EmptyState, PageHeader, StatCard, StatGrid } from '@/components/ui'
import { OptionBadges } from '@/components/contact-cards'
import { CurrencyIcon, LayersIcon, ProductsIcon, SearchIcon, TagIcon } from '@/components/icons'

export const metadata = { title: 'Products · FLO CRM' }

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string; show?: string }>
}) {
  const params = await searchParams
  const context = await requireSession()

  const search = (params.q ?? '').trim()
  const category = params.category ?? ''
  // Anything not on offer is hidden by default: the catalogue people work with
  // is the one they can still sell from. `active` is derived from the status, so
  // this one predicate covers inactive, discontinued, quarantined and sold.
  const showRetired = params.show === 'all'

  let query = scoped(context, 'products').select('*').is('deleted_at', null)
  if (search) query = query.ilike('name', likeContains(search))
  if (category) query = query.eq('category', category)
  if (!showRetired) query = query.eq('active', true)

  const [{ data }, { data: fieldOptions }, { data: stockRows }] = await Promise.all([
    query.order('name').limit(500),
    scoped(context, 'field_options')
      .select('*')
      .eq('entity_type', 'product')
      .in('field_key', ['product_category', 'product_status'])
      .order('order'),
    // One call for every product rather than one per row: committed comes off
    // the open deals, which no page-level query could see through its own
    // policies anyway.
    context.supabase.rpc('product_stock_overview'),
  ])

  const products = (data ?? []) as ProductRow[]
  const allOptions = (fieldOptions ?? []) as FieldOptionRow[]
  const categoryOptions = allOptions.filter((o) => o.field_key === 'product_category')
  const statusOptions = allOptions.filter((o) => o.field_key === 'product_status')

  type StockRow = { product_id: string; available: number; locations: string[] }
  const stockByProduct = new Map<string, StockRow>(
    ((stockRows ?? []) as StockRow[]).map((row) => [row.product_id, row]),
  )

  const active = products.filter((product) => product.active)
  const categories = new Set(products.map((product) => product.category).filter(Boolean))

  // Averaged within the organization's own currency only — mixing rates would
  // produce a headline number that means nothing.
  const base = context.organization.default_currency
  const inBase = active.filter((product) => product.currency === base)
  const averagePrice =
    inBase.length > 0
      ? inBase.reduce((sum, product) => sum + Number(product.unit_price), 0) / inBase.length
      : 0
  const withMargin = inBase.filter((product) => Number(product.unit_price) > 0)
  const averageMargin =
    withMargin.length > 0
      ? withMargin.reduce(
          (sum, p) => sum + (Number(p.unit_price) - Number(p.unit_cost)) / Number(p.unit_price),
          0,
        ) / withMargin.length
      : 0

  return (
    <>
      <PageHeader
        title="Products"
        description="What the organization sells. Deals are built from these, and every line item keeps the price it was added at."
        actions={
          context.canManage ? (
            <Link href="/products/new" className="btn-primary">
              New product
            </Link>
          ) : undefined
        }
      />

      <StatGrid>
        <StatCard label="Products" value={formatNumber(active.length)} icon={ProductsIcon} />
        <StatCard
          label="Categories"
          value={formatNumber(categories.size)}
          icon={TagIcon}
          tone="violet"
          hint="Edit the list in Settings → Fields"
        />
        <StatCard
          label={`Average price (${base})`}
          value={formatPrice(averagePrice, base)}
          icon={CurrencyIcon}
          tone="blue"
        />
        <StatCard
          label="Average margin"
          value={`${Math.round(averageMargin * 100)}%`}
          icon={LayersIcon}
          tone="amber"
        />
      </StatGrid>

      <form className="card mb-5 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-52 flex-1">
          <label className="label" htmlFor="q">
            Search
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              id="q"
              name="q"
              type="search"
              className="input pl-9"
              placeholder="Product name…"
              defaultValue={search}
            />
          </div>
        </div>

        <div className="min-w-44">
          <label className="label" htmlFor="category">
            Category
          </label>
          <select id="category" name="category" className="input" defaultValue={category}>
            <option value="">All categories</option>
            {categoryOptions.map((option) => (
              <option key={option.id} value={option.value}>
                {option.value}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 pb-2.5 text-sm text-slate-600">
          <input
            type="checkbox"
            name="show"
            value="all"
            defaultChecked={showRetired}
            className="h-4 w-4 rounded border-slate-300"
          />
          Include everything not on offer
        </label>

        <button type="submit" className="btn-secondary mb-0.5">
          Apply
        </button>
      </form>

      {products.length === 0 ? (
        <EmptyState
          title={search || category ? 'Nothing matches' : 'No products yet'}
          description={
            search || category
              ? 'Try a different search, or clear the filters.'
              : 'Add what the organization sells, then build deals from it.'
          }
          action={
            context.canManage && !search && !category ? (
              <Link href="/products/new" className="btn-primary">
                New product
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Status</th>
                <th className="text-center">Available</th>
                <th className="text-center">Location</th>
                <th className="text-center">Showroom $</th>
                <th className="text-center">Wholesale $</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const pricing = derivePricing(product)
                const stock = stockByProduct.get(product.id)
                const available = Number(stock?.available ?? 0)
                const locations = stock?.locations ?? []
                const imageUrl = productImageUrl(product.image_path)

                return (
                  <tr key={product.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <span className="icon-chip h-9 w-9 overflow-hidden bg-brand-50 text-brand-700">
                          {imageUrl ? (
                            /* The product's own photo where there is one. A 36px
                               square of a storage URL is not worth next/image,
                               which would also need a remote pattern for it. */
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={imageUrl}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <ProductsIcon className="h-4 w-4" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <Link
                            href={`/products/${product.id}`}
                            className="font-medium text-slate-900 hover:text-brand-700"
                          >
                            {product.name}
                          </Link>
                          <p className="text-xs text-slate-500">
                            {[product.brand, product.sku].filter(Boolean).join(' · ') || '—'}
                          </p>
                        </div>
                      </div>
                    </td>

                    <td>
                      <OptionBadges
                        values={product.status ? [product.status] : []}
                        options={statusOptions}
                      />
                    </td>

                    <td className={`text-center font-medium ${availableTone(available)}`}>
                      {formatQuantity(available)}
                    </td>

                    <td className="text-center text-slate-600">
                      {locations.length === 0 ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        // Everywhere it is stocked, because "TOR +2" makes
                        // somebody open the product to find out what the two are.
                        <span className="text-xs">{locations.join(' · ')}</span>
                      )}
                    </td>

                    <td className="text-center text-slate-800">
                      {formatPrice(pricing.unit.showroom.value ?? 0, product.currency)}
                    </td>

                    <td className="text-center text-slate-800">
                      {formatPrice(pricing.unit.wholesale.value ?? 0, product.currency)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
