import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatNumber, formatPrice } from '@/lib/format'
import type { CustomFieldDefinitionRow, FieldOptionRow, ProductRow } from '@/lib/database.types'
import { derivePricing } from '@/lib/products'
import { availableTone, formatQuantity } from '@/lib/stock'
import { productImageUrl } from '@/lib/product-image'
import { likeContains } from '@/lib/sql'
import { EmptyState, PageHeader, StatCard, StatGrid, SubGroupRow } from '@/components/ui'
import { CustomCell, Empty, OptionBadges } from '@/components/contact-cards'
import { columnCatalogue, resolveColumns } from '@/lib/table-columns'
import { ColumnPicker } from '@/components/column-picker'
import { GroupControls } from '@/components/group-controls'
import { PRODUCT_GROUP_FIELDS, groupRowsNested } from '@/lib/filters'
import { formatDay } from '@/lib/format'

import { readColumns } from '../column-actions'
import { CurrencyIcon, LayersIcon, ProductsIcon, SearchIcon, TagIcon } from '@/components/icons'

export const metadata = { title: 'Products · FLO CRM' }

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    category?: string
    show?: string
    group?: string
    subgroup?: string
  }>
}) {
  const params = await searchParams
  const context = await requireSession()

  const search = (params.q ?? '').trim()
  const category = params.category ?? ''

  /*
   * Only fields the list actually offers. A group key arrives in the URL, so it
   * is somebody's typo or somebody's experiment until it has been checked
   * against the list — an unrecognised one groups by a column that does not
   * exist and puts every product in "None".
   *
   * Dropping the group drops the sub-group with it: a sub-group with nothing to
   * nest inside would silently become the grouping, which is not what the URL
   * says.
   */
  const groupable = (key: string | undefined) =>
    PRODUCT_GROUP_FIELDS.some((field) => field.key === key) ? (key as string) : ''
  const groupBy = groupable(params.group)
  const subGroupBy = groupBy ? groupable(params.subgroup) : ''
  // Anything not on offer is hidden by default: the catalogue people work with
  // is the one they can still sell from. `active` is derived from the status, so
  // this one predicate covers inactive, discontinued, quarantined and sold.
  const showRetired = params.show === 'all'

  let query = scoped(context, 'products').select('*').is('deleted_at', null)
  if (search) query = query.ilike('name', likeContains(search))
  if (category) query = query.eq('category', category)
  if (!showRetired) query = query.eq('active', true)

  const [{ data }, { data: fieldOptions }, { data: stockRows }, { data: definitionRows }] =
    await Promise.all([
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

  // Every groupable field on a product is already a readable string — a
  // category, a brand, a currency code — so the only label worth writing is
  // the one for the products that have none.
  const groups = groupRowsNested(products, groupBy, subGroupBy, (_field, value) => value ?? 'None')

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

        <GroupControls fields={PRODUCT_GROUP_FIELDS} groupBy={groupBy} subGroupBy={subGroupBy} />

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
        <div className="space-y-8">
          {groups.map((group) => (
            <div key={group.key ?? 'all'}>
              {groupBy && (
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
