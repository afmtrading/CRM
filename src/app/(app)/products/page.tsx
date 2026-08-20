import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatCurrency, formatNumber, formatPrice } from '@/lib/format'
import type {
  CustomFieldDefinitionRow,
  FieldOptionRow,
  ProductRow,
  TagRow,
} from '@/lib/database.types'
import { derivePricing } from '@/lib/products'
import { round2 } from '@/lib/sales'
import { availableTone, formatQuantity } from '@/lib/stock'
import { startOfMonthIn } from '@/lib/timezone'
import { productImageUrl } from '@/lib/product-image'
import {
  EmptyState,
  GroupOverlapNote,
  PageHeader,
  StatCard,
  StatGrid,
} from '@/components/ui'
import { CollapsibleGroup, CollapsibleSubGroup } from '@/components/collapsible'
import { InlineEdit, InlineText, type InlineOption } from '@/components/inline-edit'
import { CustomCell, Empty, OptionBadges } from '@/components/contact-cards'
import { columnCatalogue, resolveColumns } from '@/lib/table-columns'
import { ColumnPicker } from '@/components/column-picker'
import { FilterBar } from '@/components/filter-bar'
import {
  applyFilter,
  fieldsFor,
  filterFromSearchParams,
  groupRowsNested,
  overlappingGroupField,
  labelFromFields,
  parseFilterConfig,
  TAGS_FIELD_KEY,
} from '@/lib/filters'
import type { SavedFilterRow } from '@/lib/database.types'
import { formatDay } from '@/lib/format'

import { deleteSavedFilter, saveFilter } from '../contacts/actions'
import { readColumns } from '../column-actions'
import { CurrencyIcon, LayersIcon, ProductsIcon, TrendingUpIcon } from '@/components/icons'

/*
 * Never served from the route cache.
 *
 * These read per-request, per-tenant data behind an authenticated session, and
 * the App Router will happily hand back a previously rendered page otherwise —
 * which shows up as a deploy that went out and a screen that did not change.
 * The sales and invoice screens have said this since they were written; the
 * rest of the record pages were relying on it not happening.
 */
export const dynamic = 'force-dynamic'

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

  /*
   * Ahead of the query rather than beside it. A tag condition becomes a
   * predicate on `id` — see tagPredicate — so the join has to be in hand before
   * the query is built; asked for alongside it, there would be nothing to build
   * the predicate from. Two small reads for the whole page either way.
   */
  const [{ data: tagRows }, { data: productTagRows }] = await Promise.all([
    scoped(context, 'tags').select('id, name, color').order('name'),
    scoped(context, 'product_tags').select('product_id, tag_id'),
  ])

  const tagList = (tagRows ?? []) as Pick<TagRow, 'id' | 'name' | 'color'>[]
  const tagIdsByProduct = new Map<string, string[]>()
  for (const link of (productTagRows ?? []) as { product_id: string; tag_id: string }[]) {
    const list = tagIdsByProduct.get(link.product_id)
    if (list) list.push(link.tag_id)
    else tagIdsByProduct.set(link.product_id, [link.tag_id])
  }

  let query = scoped(context, 'products').select('*').is('deleted_at', null)
  if (!showRetired) query = query.eq('active', true)
  // A catalogue is read alphabetically, not newest-first — which is what
  // applyFilter would otherwise fall back to.
  query = applyFilter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query as any,
    config,
    'product',
    { column: 'name', ascending: true },
    tagIdsByProduct,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any

  const [
    { data },
    { data: fieldOptions },
    { data: stockRows },
    { data: definitionRows },
  ] = await Promise.all([
    query.limit(500),
    /*
     * Every product list, not a named few. It used to name three keys, which
     * meant the Priority column added later drew its badges from an empty list
     * and rendered them colourless — a filter that silently excludes the next
     * field somebody adds is a trap, and the rows are a handful either way.
     */
    scoped(context, 'field_options')
      .select('*')
      .eq('entity_type', 'product')
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

  /*
   * Tags ride along on the row so the grouping can read them. They are not a
   * column, and groupRows has only the row to work from.
   */
  const products = ((data ?? []) as ProductRow[]).map((product) => ({
    ...product,
    [TAGS_FIELD_KEY]: tagIdsByProduct.get(product.id) ?? [],
  }))
  const definitions = (definitionRows ?? []) as CustomFieldDefinitionRow[]
  const savedColumns = await readColumns('product')
  const allOptions = (fieldOptions ?? []) as FieldOptionRow[]
  const categoryOptions = allOptions.filter((o) => o.field_key === 'product_category')
  const statusOptions = allOptions.filter((o) => o.field_key === 'product_status')
  const typeOptions = allOptions.filter((o) => o.field_key === 'product_type')
  const priorityOptions = allOptions.filter((o) => o.field_key === 'priority')

  const conditionOptions = allOptions.filter((o) => o.field_key === 'product_condition')

  /*
   * The option lists in the shape an editable cell wants, built once for the
   * whole table rather than per row: React writes an object it has already
   * written as a back-reference, so one shared array costs one copy in the
   * payload while a fresh array per row costs two hundred.
   */
  const inlineOptions = (rows: FieldOptionRow[]): InlineOption[] =>
    rows.map((option) => ({ value: option.value, label: option.value, color: option.color }))

  const statusInline = inlineOptions(statusOptions)
  const categoryInline = inlineOptions(categoryOptions)
  const conditionInline = inlineOptions(conditionOptions)
  const priorityInline = inlineOptions(priorityOptions)

  /*
   * Tag colours are hexes an admin chose in Settings → Tags rather than one of
   * the ten named ones, so they ride as a swatch — see InlineOption. Which
   * product carries which is already `tagIdsByProduct`, built above for the
   * filter.
   */
  const tagOptions: InlineOption[] = tagList.map((tag) => ({
    value: tag.id,
    label: tag.name,
    swatch: tag.color,
  }))

  /*
   * The catalogue is the desk's reference data rather than anybody's record,
   * and its policy asks for the manage capability — the same one the New
   * product button asks for. Tags are the exception the join table's own
   * policy makes: putting a word on a line only takes write access.
   */
  const canPrice = context.canManage
  const canTag = context.canWrite

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

  // Scoped to what is actually on screen, like the two value totals below —
  // filter to one brand and this says how many of that brand are new.
  //
  // The month begins on the organization's clock. The server runs in UTC, so a
  // product added at nine on the evening of the 31st in Toronto had already
  // been counted against the following month.
  const monthStart = startOfMonthIn(context.organization.timezone)
  const newThisMonth = products.filter((product) => new Date(product.created_at) >= monthStart)

  /*
   * What the shelves are worth at each price level.
   *
   * Stock-weighted, not a sum of price tags: a total that added one unit of a
   * $900 item to two hundred of a $2 one would be a number about the price
   * list rather than about the warehouse. On hand rather than available,
   * because goods already promised to somebody are still goods you own.
   *
   * One currency, asked for and taken literally: the organization's own. Not
   * because currencies add up — they do not, which is why every other total in
   * this app stands as one subtotal per currency — but because a headline is a
   * single number or it is not a headline, and a catalogue priced mostly in one
   * currency does not need four.
   *
   * What that costs is said out loud rather than hidden. The card carries the
   * currency in its label, and if anything was left out it says how much, so a
   * warehouse full of CAD stock cannot read as a small number without
   * explaining itself. The card this replaced excluded the same products and
   * mentioned none of it.
   *
   * Over the products actually listed, so the totals describe what is on the
   * screen: filter to one brand and these say what that brand is worth.
   */
  const base = context.organization.default_currency
  const inBase = products.filter((product) => product.currency === base)
  const setAside = products.length - inBase.length

  const stockValue = (pick: (product: ProductRow) => number | null) =>
    inBase.reduce((total, product) => {
      const unit = pick(product)
      if (unit === null) return total
      return round2(total + unit * Number(stockByProduct.get(product.id)?.on_hand ?? 0))
    }, 0)

  const showroomValue = stockValue((product) => derivePricing(product).unit.showroom.value)
  const wholesaleValue = stockValue((product) => derivePricing(product).unit.wholesale.value)

  /** Said on both cards, because a total that quietly skipped rows is a wrong total. */
  const priced = (what: string) =>
    setAside > 0
      ? `On hand, at ${what} prices · ${formatNumber(setAside)} not in ${base}`
      : `On hand, at ${what} prices`

  const catalogue = columnCatalogue('product', definitions)
  const columns = resolveColumns('product', savedColumns, catalogue)

  /*
   * The catalogue's own option lists, so a condition on category or status
   * offers the values that exist rather than a free-text box. Custom fields
   * come with their own options through fieldsFor.
   */
  const listFor: Record<string, FieldOptionRow[]> = {
    category: categoryOptions,
    status: statusOptions,
    product_type: typeOptions,
    priority: priorityOptions,
  }
  const fields = fieldsFor('product', definitions, allOptions).map((field) => {
    /*
     * Tags are offered by id and read by name. A saved view that named them
     * would stop matching the moment somebody renamed one in Settings.
     */
    if (field.key === TAGS_FIELD_KEY) {
      return { ...field, options: tagList.map((tag) => ({ value: tag.id, label: tag.name })) }
    }
    const list = listFor[field.key]
    return list ? { ...field, options: list.map((o) => ({ value: o.value, label: o.value })) } : field
  })

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
  // Tags put a record in every group it is tagged with, so the counts add up
  // to more than the list. The page says so rather than looking wrong.
  const overlap = overlappingGroupField(fields, config.groupBy, config.subGroupBy)


  const groups = groupRowsNested(
    products,
    config.groupBy,
    config.subGroupBy,
    labelFromFields(fields),
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
              {/*
                What the thing is, in the words somebody would use to ask for
                it: the make, how many are in it, how big it is, which one it
                is. The SKU was here and is not any of those — it is how the
                warehouse addresses it, and it has its own column for anybody
                who needs it.
              */}
              <p className="text-xs text-slate-500">
                {[product.brand, product.item_count, product.size, product.model]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </p>
            </div>
          </div>
        )
      }
      /*
       * From here down the cell is the editor: click it, pick or type, and it
       * is written. A catalogue is re-graded and repriced far more often than
       * a contact is re-titled, and until now none of it could be done without
       * opening each product in turn.
       */
      case 'status':
        return (
          <InlineEdit
            entity="product"
            id={product.id}
            field="status"
            fieldLabel="Status"
            values={product.status ? [product.status] : []}
            options={statusInline}
            canEdit={canPrice}
          />
        )
      case 'product_type':
        return (
          <OptionBadges
            values={product.product_type ? [product.product_type] : []}
            options={typeOptions}
          />
        )
      case 'priority':
        return (
          <InlineEdit
            entity="product"
            id={product.id}
            field="priority"
            fieldLabel="Priority"
            values={product.priority ? [product.priority] : []}
            options={priorityInline}
            canEdit={canPrice}
          />
        )
      case 'tags':
        /*
         * The same menu the vocabulary fields use, over a different table:
         * tags are a join rather than a column. Write access rather than
         * manage, which is what the join table's own policy asks for.
         */
        return (
          <InlineEdit
            as="tags"
            entity="product"
            id={product.id}
            field="tags"
            fieldLabel="Tags"
            values={tagIdsByProduct.get(product.id) ?? []}
            options={tagOptions}
            multiple
            canEdit={canTag}
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
      /*
       * Showroom and wholesale are overrides, and the box is empty when there
       * is not one — what the cell shows is the derived figure, and it shows
       * again as the input's placeholder. So typing sets an override, and
       * emptying the box takes it back to following retail rather than
       * standing at zero. `auto` is what derivePricing calls the difference.
       */
      case 'price_showroom':
        return (
          <InlineText
            entity="product"
            id={product.id}
            field="price_showroom"
            fieldLabel="Showroom price"
            kind="number"
            align="center"
            value={product.price_showroom === null ? '' : String(product.price_showroom)}
            placeholder={
              pricing.unit.showroom.value === null
                ? undefined
                : String(pricing.unit.showroom.value)
            }
            display={
              <span className={pricing.unit.showroom.auto ? 'text-slate-400' : 'text-slate-800'}>
                {money(pricing.unit.showroom.value)}
              </span>
            }
            canEdit={canPrice}
          />
        )
      case 'price_wholesale':
        return (
          <InlineText
            entity="product"
            id={product.id}
            field="price_wholesale"
            fieldLabel="Wholesale price"
            kind="number"
            align="center"
            value={product.price_wholesale === null ? '' : String(product.price_wholesale)}
            placeholder={
              pricing.unit.wholesale.value === null
                ? undefined
                : String(pricing.unit.wholesale.value)
            }
            display={
              <span className={pricing.unit.wholesale.auto ? 'text-slate-400' : 'text-slate-800'}>
                {money(pricing.unit.wholesale.value)}
              </span>
            }
            canEdit={canPrice}
          />
        )
      /*
       * Retail and cost are the stored columns the other two derive from —
       * `unit_price` and `unit_cost`, whatever the column headings say. Both
       * are NOT NULL with a zero default, so there is no clearing them: a
       * price of nothing is nought.
       */
      case 'price_retail':
        return (
          <InlineText
            entity="product"
            id={product.id}
            field="unit_price"
            fieldLabel="Retail price"
            kind="number"
            align="center"
            value={String(product.unit_price ?? '')}
            display={<span className="text-slate-600">{money(pricing.unit.retail.value)}</span>}
            canEdit={canPrice}
          />
        )
      case 'unit_cost':
        return (
          <InlineText
            entity="product"
            id={product.id}
            field="unit_cost"
            fieldLabel="Cost"
            kind="number"
            align="center"
            value={String(product.unit_cost ?? '')}
            display={<span className="text-slate-600">{money(pricing.unit.cost.value)}</span>}
            canEdit={canPrice}
          />
        )
      case 'brand':
        return (
          <InlineText
            entity="product"
            id={product.id}
            field="brand"
            fieldLabel="Brand"
            value={product.brand ?? ''}
            display={
              product.brand ? (
                <span className="block truncate text-slate-600">{product.brand}</span>
              ) : (
                <Empty />
              )
            }
            canEdit={canPrice}
          />
        )
      case 'sku':
        return (
          <InlineText
            entity="product"
            id={product.id}
            field="sku"
            fieldLabel="SKU"
            value={product.sku ?? ''}
            display={
              product.sku ? (
                <span className="whitespace-nowrap text-slate-600">{product.sku}</span>
              ) : (
                <Empty />
              )
            }
            canEdit={canPrice}
          />
        )
      /*
       * Category and condition have option lists behind them — the same ones
       * the product's own record draws its badges from — so they are picked
       * rather than typed, and the list shows the badge the record does.
       */
      case 'category':
        return (
          <InlineEdit
            entity="product"
            id={product.id}
            field="category"
            fieldLabel="Category"
            values={product.category ? [product.category] : []}
            options={categoryInline}
            canEdit={canPrice}
          />
        )
      case 'product_condition':
        return (
          <InlineEdit
            entity="product"
            id={product.id}
            field="product_condition"
            fieldLabel="Condition"
            values={product.product_condition ? [product.product_condition] : []}
            options={conditionInline}
            canEdit={canPrice}
          />
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

  /* One row, named so a sub-group can hand it to the fold that holds it. */
  const productRow = (product: ProductRow) => (
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
  )

  return (
    <>
      <PageHeader
        title="Products"
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
        <StatCard label="Total products" value={formatNumber(active.length)} icon={ProductsIcon} />
        <StatCard
          label="New this month"
          value={formatNumber(newThisMonth.length)}
          icon={TrendingUpIcon}
          tone="brand"
          trend={
            newThisMonth.length > 0
              ? { label: `+${newThisMonth.length}`, direction: 'up' }
              : undefined
          }
        />
        <StatCard
          label={`Showroom value (${base})`}
          value={formatCurrency(showroomValue, base)}
          icon={CurrencyIcon}
          tone="blue"
          hint={priced('showroom')}
        />
        <StatCard
          label={`Wholesale value (${base})`}
          value={formatCurrency(wholesaleValue, base)}
          icon={LayersIcon}
          tone="amber"
          hint={priced('wholesale')}
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
        <>
          {overlap && <GroupOverlapNote label={overlap.label} />}
          <div className="space-y-8">
            {groups.map((group) => (
            <CollapsibleGroup
              key={group.key ?? 'all'}
              scope="product"
              id={group.key ?? 'all'}
              /* No heading when the list is not grouped — and then nothing to fold. */
              label={config.groupBy ? group.label : undefined}
              summary={
                config.groupBy ? (
                  <span className="badge bg-brand-100 text-brand-700">{group.rows.length}</span>
                ) : undefined
              }
            >
              {/*
                The card starts here rather than around the heading, so the
                rounded corners land on the column header row.
              */}
              <div className="group-panel overflow-x-auto">
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
                      With a sub-group, each one gets a band it can be folded
                      away by and then its rows; without, the rows go straight
                      in. Same table either way, so the columns keep their
                      widths.
                    */}
                    {group.subGroups
                      ? group.subGroups.map((sub) => (
                          <CollapsibleSubGroup
                            key={`sub-${sub.key ?? 'none'}`}
                            scope="product"
                            id={`${group.key ?? 'all'}/${sub.key ?? 'none'}`}
                            label={sub.label}
                            count={sub.rows.length}
                            columns={columns.length}
                          >
                            {sub.rows.map(productRow)}
                          </CollapsibleSubGroup>
                        ))
                      : group.rows.map(productRow)}
                  </tbody>
                </table>
              </div>
            </CollapsibleGroup>
          ))}
          </div>
        </>
      )}
    </>
  )
}
