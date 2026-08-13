import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatNumber, formatPrice } from '@/lib/format'
import type { FieldOptionRow, ProductRow } from '@/lib/database.types'
import { productStatusLabel, productStatusTone } from '@/lib/products'
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
  if (search) query = query.ilike('name', `%${search}%`)
  if (category) query = query.eq('category', category)
  if (!showRetired) query = query.eq('active', true)

  const [{ data }, { data: fieldOptions }] = await Promise.all([
    query.order('name').limit(500),
    scoped(context, 'field_options')
      .select('*')
      .eq('entity_type', 'product')
      .eq('field_key', 'product_category')
      .order('order'),
  ])

  const products = (data ?? []) as ProductRow[]
  const categoryOptions = (fieldOptions ?? []) as FieldOptionRow[]

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
                <th>Category</th>
                <th>Unit</th>
                <th className="text-right">Unit retail</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const price = Number(product.unit_price)
                const margin = price - Number(product.unit_cost)
                const pct = price > 0 ? Math.round((margin / price) * 100) : null

                return (
                  <tr key={product.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <span className="icon-chip h-9 w-9 bg-brand-50 text-brand-700">
                          <ProductsIcon className="h-4 w-4" />
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
                            {!product.active && (
                              <span className={`badge ml-2 ${productStatusTone(product.status)}`}>
                                {productStatusLabel(product.status)}
                              </span>
                            )}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <OptionBadges
                        values={product.category ? [product.category] : []}
                        options={categoryOptions}
                      />
                    </td>
                    <td className="text-slate-600">{product.unit || '—'}</td>
                    <td className="text-right text-slate-800">
                      {formatPrice(price, product.currency)}
                    </td>
                    <td className="text-right text-slate-600">
                      {formatPrice(Number(product.unit_cost), product.currency)}
                    </td>
                    <td
                      className={`text-right font-medium ${
                        margin < 0 ? 'text-red-600' : 'text-slate-800'
                      }`}
                    >
                      {formatPrice(margin, product.currency)}
                      {pct !== null && <span className="ml-1 text-xs text-slate-400">{pct}%</span>}
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
