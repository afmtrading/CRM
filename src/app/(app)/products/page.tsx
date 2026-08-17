import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatNumber, formatPrice } from '@/lib/format'
import type { CustomFieldDefinitionRow, FieldOptionRow, ProductRow } from '@/lib/database.types'
import { derivePricing } from '@/lib/products'
import { availableTone, formatQuantity } from '@/lib/stock'
import { productImageUrl } from '@/lib/product-image'
import { EmptyState, PageHeader, StatCard, StatGrid, SubGroupRow } from '@/components/ui'
import { CustomCell, Empty, OptionBadges } from '@/components/contact-cards'
import { columnCatalogue, resolveColumns } from '@/lib/table-columns'
import { ColumnPicker } from '@/components/column-picker'
import { FilterBar } from '@/components/filter-bar'
import {
  applyFilter,
  fieldsFor,
  filterFromSearchParams,
  groupRowsNested,
  parseFilterConfig,
} from '@/lib/filters'
import type { SavedFilterRow } from '@/lib/database.types'
import { formatDay } from '@/lib/format'

import { deleteSavedFilter, saveFilter } from '../contacts/actions'
import { readColumns } from '../column-actions'
import { CurrencyIcon, LayersIcon, ProductsIcon, TagIcon } from '@/components/icons'

export const metadata = { title: 'Products · FLO CRM' }

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    show?: string
    view?: string
    f?: string
    match?: string
    group?: string
    subgroup?: string
    sort?: string
  }>
}) {
  const params = await searchParams
  const context = await requireSession()

  // Anything not on offer is hidden by default: the catalogue people work with
  // is the one they can still sell from. `active` is derived from the status, so
  // this one predicate covers inactive, discontinued, quarantined and sold.
  const showRetired = params.show === 'all'

  const { data: savedFilterRows } = await scoped(context, 'saved_filters')
    .select('*')
    .eq('entity_type', 'product')
  const savedFilters = (savedFilterRows ?? []) as SavedFilterRow[]

  // A ?view=<id> link replays a saved filter; anything else comes from the URL.
  const savedView =
    typeof params.view === 'string'
      ? savedFilters.find((filter) => filter.id === params.view)
      : undefined
  const config = savedView ? parseFilterConfig(savedView.filter_json) : filterFromSearchParams(params)

  let query = scoped(context, 'products').select('*').is('deleted_at', null)
  if (!showRetired) query = query.eq('active', true)
  // A catalogue is read alphabetically, not newest-first — which is what
  // applyFilter would otherwise fall back to.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = applyFilter(query as any, config, 'product', { column: 'name', ascending: true }) as any

  const [{ data }, { data: fieldOptions }, { data: stockRows }, { data: definitionRows }] =
    await Promise.all([
    query.limit(500),
    scoped(context, 'field_options')
      .select('*')
      .eq('entity_type', 'product')
      .in('field_key', ['product_category', 'product_status'])
      .order('order'),
    // One call for every product rather than one per row: committed comes off
    // the open deals, which no page-level query could see through its own
    // policies anyway.
    context.supabase.rpc('product_stock_overview'),
    // For the column catalogue: a custom field on a product is a column like
    // any other, so the picker has to know they exist.
    scoped(context, 'custom_field_definitions')
      .select('*')
      .eq('entity_type', 'product')
      .order('order'),
  ])

  const products = (data ?? []) as ProductRow[]
  const definitions = (definitionRows ?? []) as CustomFieldDefinitionRow[]
  const savedColumns = await readColumns('product')
  const allOptions = (fieldOptions ?? []) as FieldOptionRow[]
  const categoryOptions = allOptions.filter((o) => o.field_key === 'product_category')
  const statusOptions = allOptions.filter((o) => o.field_key === 'product_status')

  type StockRow = {
    product_id: string
    available: number
    on_hand: number
    committed: number
    locations: string[]
  }
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

  const catalogue = columnCatalogue('product', definitions)
  const columns = resolveColumns('product', savedColumns, catalogue)

  /*
   * The catalogue's own option lists, so a condition on category or status
   * offers the values that exist rather than a free-text box. Custom fields
   * come with their own options through fieldsFor.
   */
  const fields = fieldsFor('product', definitions, allOptions).map((field) =>
    field.key === 'category'
      ? { ...field, options: categoryOptions.map((o) => ({ value: o.value, label: o.value })) }
      : field.key === 'status'
        ? { ...field, options: statusOptions.map((o) => ({ value: o.value, label: o.value })) }
        : field,
  )

  // "Nothing matches" versus "nothing here yet" — the difference is whether
  // anything was asked for, and the retired toggle is not asking.
  const narrowed = Boolean(config.search) || config.conditions.length > 0

  /*
   * The current URL with `show` flipped, so toggling retired products keeps the
   * filter, the grouping and the sort somebody has already set up rather than
   * dropping them on the floor.
   */
  const retiredToggle = new URLSearchParams(
    Object.entries(params).filter(([key, value]) => key !== 'show' && typeof value === 'string') as [
      string,
      string,
    ][],
  )
  if (!showRetired) retiredToggle.set('show', 'all')

  // Every groupable field on a product is already a readable string — a
  // category, a brand, a currency code — so the only label worth writing is
  // the one for the products that have none.
  const groups = groupRowsNested(
    products,
    config.groupBy,
    config.subGroupBy,
    (_field, value) => value ?? 'None',
  )

  /*
   * One cell, by key. Prices go through derivePricing rather than being read
   * off the row, because showroom and wholesale are usually not stored at all —
   * they are 70% and 30% of retail until somebody overrides them, and reading
   * the column directly would show a blank for most of the catalogue.
   */
  const cell = (product: ProductRow, key: string): React.ReactNode => {
    const pricing = derivePricing(product)
    const stock = stockByProduct.get(product.id)
    /*
     * A price that derives to nothing shows an em dash rather than $0.00.
     * Zero is a price somebody could have meant; blank is the honest reading of
     * a retail price nobody has typed yet.
     */
    const money = (value: number | null) =>
      value === null ? <Empty /> : formatPrice(value, product.currency)

    switch (key) {
      case 'name': {
        const imageUrl = productImageUrl(product.image_path)
        return (
          <div className="flex items-center gap-3">
            <span className="icon-chip h-9 w-9 overflow-hidden bg-brand-50 text-brand-700">
              {imageUrl ? (
                /* The product's own photo where there is one. A 36px square of
                   a storage URL is not worth next/image, which would also need
                   a remote pattern for it — but it is worth the three
                   attributes next/image would have set: intrinsic size so the
                   browser reserves the box, and lazy loading so a catalogue of
                   fifty does not fetch fifty images above the fold. */
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl}
                  alt=""
                  width={36}
                  height={36}
                  loading="lazy"
                  decoding="async"
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
        )
      }
      case 'status':
        return (
          <OptionBadges
            values={product.status ? [product.status] : []}
            options={statusOptions}
          />
        )
      case 'available': {
        const available = Number(stock?.available ?? 0)
        return (
          <span className={`font-medium ${availableTone(available)}`}>
            {formatQuantity(available)}
          </span>
        )
      }
      case 'on_hand':
        return <span className="text-slate-600">{formatQuantity(Number(stock?.on_hand ?? 0))}</span>
      case 'committed':
        return (
          <span className="text-slate-600">{formatQuantity(Number(stock?.committed ?? 0))}</span>
        )
      case 'location': {
        const locations = stock?.locations ?? []
        return locations.length === 0 ? (
          <Empty />
        ) : (
          // Everywhere it is stocked, because "TOR +2" makes somebody open the
          // product to find out what the two are.
          <span className="text-xs text-slate-600">{locations.join(' · ')}</span>
        )
      }
      case 'price_showroom':
        return <span className="text-slate-800">{money(pricing.unit.showroom.value)}</span>
      case 'price_wholesale':
        return <span className="text-slate-800">{money(pricing.unit.wholesale.value)}</span>
      case 'price_retail':
        return <span className="text-slate-600">{money(pricing.unit.retail.value)}</span>
      case 'unit_cost':
        return <span className="text-slate-600">{money(pricing.unit.cost.value)}</span>
      case 'brand':
        return product.brand ? (
          <span className="block truncate text-slate-600">{product.brand}</span>
        ) : (
          <Empty />
        )
      case 'sku':
        return product.sku ? (
          <span className="whitespace-nowrap text-slate-600">{product.sku}</span>
        ) : (
          <Empty />
        )
      case 'category':
        return product.category ? (
          <span className="block truncate text-slate-600">{product.category}</span>
        ) : (
          <Empty />
        )
      case 'product_condition':
        return product.product_condition ? (
          <span className="block truncate text-slate-600">{product.product_condition}</span>
        ) : (
          <Empty />
        )
      case 'case_pack':
        return product.case_pack ? (
          <span className="text-slate-600">{formatNumber(Number(product.case_pack))}</span>
        ) : (
          <Empty />
        )
      case 'created_at':
        return <span className="text-slate-600">{formatDay(product.created_at)}</span>
      default:
        return <CustomCell row={product} columnKey={key} />
    }
  }

  return (
    <>
      <PageHeader
        title="Products"
        description="What the organization sells. Deals are built from these, and every line item keeps the price it was added at."
        actions={
          <>
            <ColumnPicker
              entity="product"
              catalogue={catalogue}
              selected={columns.map((column) => column.key)}
            />
            {context.canManage && (
              <Link href="/products/new" className="btn-primary">
                New product
              </Link>
            )}
          </>
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

      <FilterBar
        fields={fields}
        initial={config}
        savedFilters={savedFilters}
        entityType="product"
        currentUserId={context.user.id}
        canExport={context.canBulk}
        saveAction={saveFilter}
        deleteAction={deleteSavedFilter}
      />

      {/*
        Whether retired products are on the page at all is a predicate on the
        query rather than a condition in the filter, so it is a link that keeps
        everything else in the URL — not a second form somebody has to remember
        to submit.
      */}
      <p className="mb-5 text-sm text-slate-500">
        {showRetired ? 'Showing everything, on offer or not.' : 'Showing what is on offer.'}{' '}
        <Link href={`/products?${retiredToggle.toString()}`} className="text-brand-700 underline">
          {showRetired ? 'Hide what is not on offer' : 'Include everything not on offer'}
        </Link>
      </p>

      {products.length === 0 ? (
        <EmptyState
          title={narrowed ? 'Nothing matches' : 'No products yet'}
          description={
            narrowed
              ? 'Try a different search, or clear the filters.'
              : 'Add what the organization sells, then build deals from it.'
          }
          action={
            context.canManage && !narrowed ? (
              <Link href="/products/new" className="btn-primary">
                New product
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <div key={group.key ?? 'all'}>
              {config.groupBy && (
                <div className="group-header flex items-baseline justify-between gap-3">
                  <h2>{group.label}</h2>
                  <span className="badge bg-brand-100 text-brand-700">{group.rows.length}</span>
                </div>
              )}
              {/*
                The card starts here rather than around the heading, so the
                rounded corners land on the column header row.
              */}
              <div className="card overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      {/*
                        Whatever this person chose, in their order. The defaults
                        are what the catalogue is usually opened for — is it
                        sellable, how many, where, and at what — and the rest of
                        the fields are a tick away in Columns.
                      */}
                      {columns.map((column) => (
                        <th
                          key={column.key}
                          className={
                            column.align === 'center'
                              ? 'text-center'
                              : column.align === 'right'
                                ? 'text-right'
                                : undefined
                          }
                        >
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/*
                      With a sub-group, each one gets a heading row and then its
                      rows; without, the rows go straight in. Same table either
                      way, so the columns keep their widths.
                    */}
                    {(group.subGroups ?? [{ key: null, label: '', rows: group.rows }]).flatMap(
                      (sub) => [
                        ...(group.subGroups
                          ? [
                              <SubGroupRow
                                key={`sub-${sub.key ?? 'none'}`}
                                label={sub.label}
                                count={sub.rows.length}
                                columns={columns.length}
                              />,
                            ]
                          : []),
                        ...sub.rows.map((product) => (
                          <tr key={product.id}>
                            {columns.map((column) => (
                              <td
                                key={column.key}
                                className={
                                  column.align === 'center'
                                    ? 'text-center'
                                    : column.align === 'right'
                                      ? 'text-right'
                                      : undefined
                                }
                              >
                                {cell(product, column.key)}
                              </td>
                            ))}
                          </tr>
                        )),
                      ],
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
