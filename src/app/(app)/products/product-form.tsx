'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'

import type {
  CustomFieldDefinitionRow,
  FieldOptionRow,
  ProductRow,
  StockBinRow,
  StockLocationRow,
  TagRow,
} from '@/lib/database.types'
import type { StockEntry } from '@/lib/stock'
import { CURRENCIES, formatPrice } from '@/lib/format'
import { PRODUCT_CARDS, optionsForField } from '@/lib/field-options'
import {
  PRODUCT_ACTIVE_STATUS,
  derivePricing,
  showroomMargin,
  wholesaleMargin,
} from '@/lib/products'
import {
  CustomFieldInputs,
  FormCard,
  FormSection,
  NotesEditor,
  RadioChips,
} from '@/components/form-fields'
import { TagPicker } from '@/components/tag-picker'

import { productImageUrl } from '@/lib/product-image'

import type { ProductActionState } from './actions'
import { ProductImageField } from './image-field'
import { StockEditor } from './stock-editor'

/** A null column and an untouched box are the same thing to a form. */
function box(value: number | string | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

/** A short line under a field, in the shape the price list uses. */
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-slate-400">{children}</p>
}

/**
 * One money box.
 *
 * `auto` is the number this field would hold if it were left alone, shown as
 * the placeholder — so an empty box is never a mystery, and typing over it is
 * visibly an override rather than the only way to get a value.
 */
function MoneyField({
  name,
  label,
  hint,
  value,
  auto,
  onChange,
}: {
  name: string
  label: string
  hint?: string
  value: string
  auto?: number | null
  onChange?: (value: string) => void
}) {
  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="number"
        step="0.01"
        min="0"
        inputMode="decimal"
        className="input"
        placeholder={auto !== null && auto !== undefined ? auto.toFixed(2) : undefined}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
      {hint && <Hint>{hint}</Hint>}
    </div>
  )
}

/**
 * A select whose options an administrator owns.
 *
 * Drawn from field_options rather than from a list in the code, so Product
 * Type, Condition and Status are edited in Settings → Fields alongside
 * Category. Rendered as a dropdown rather than as coloured chips because five
 * to ten states is more list than the eye wants to scan across a form.
 */
function OptionSelect({
  name,
  label,
  options,
  value,
  hint,
  required = false,
}: {
  name: string
  label: string
  options: FieldOptionRow[]
  value: string
  hint?: string
  required?: boolean
}) {
  // A value saved before somebody edited the list would otherwise vanish from
  // the dropdown and be silently rewritten on the next save.
  const orphan = value && !options.some((option) => option.value === value) ? value : null

  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
      </label>
      <select id={name} name={name} className="input" defaultValue={value}>
        {!required && <option value="">—</option>}
        {options.map((option) => (
          <option key={option.id} value={option.value}>
            {option.value}
          </option>
        ))}
        {orphan && <option value={orphan}>{orphan} (no longer on the list)</option>}
      </select>
      {options.length === 0 ? (
        <Hint>
          <Link href="/settings/fields" className="text-brand-700 hover:underline">
            Add some options
          </Link>{' '}
          in Settings &rarr; Fields.
        </Hint>
      ) : (
        hint && <Hint>{hint}</Hint>
      )}
    </div>
  )
}

/** A margin, worked out as the prices are typed. */
function MarginReadout({
  label,
  margin,
  currency,
  hint,
}: {
  label: string
  margin: { amount: number; percent: number | null }
  currency: string
  hint: string
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <p
        className={`mt-1 text-sm font-medium ${
          margin.amount < 0 ? 'text-red-600' : 'text-slate-800'
        }`}
      >
        {formatPrice(margin.amount, currency)}
        {margin.percent !== null && (
          <span className="ml-2 text-xs font-normal text-slate-500">{margin.percent}%</span>
        )}
      </p>
      <Hint>{margin.amount < 0 ? 'The price is below cost.' : hint}</Hint>
    </div>
  )
}

export function ProductForm({
  action,
  product,
  customFields,
  fieldOptions,
  defaultCurrency,
  submitLabel,
  locations,
  bins,
  stock,
  committed = 0,
  tags,
  selectedTagIds = [],
  canManage = false,
}: {
  action: (state: ProductActionState, formData: FormData) => Promise<ProductActionState>
  product?: ProductRow
  customFields: CustomFieldDefinitionRow[]
  fieldOptions: FieldOptionRow[]
  defaultCurrency: string
  submitLabel: string
  locations: StockLocationRow[]
  bins: StockBinRow[]
  stock: StockEntry[]
  committed?: number
  /** The organization's tags, shared with contacts and companies. */
  tags: TagRow[]
  /** Empty on a new product, which is the point — it can be tagged as it is created. */
  selectedTagIds?: string[]
  /** Only an admin is offered the link to Settings → Tags. */
  canManage?: boolean
}) {
  const [state, formAction, pending] = useActionState(action, {} as ProductActionState)

  /*
   * Only the boxes that feed a calculation are held in state. Retail drives the
   * two other unit prices, those three and the case pack drive the piece
   * prices, and cost decides the margin. Everything else on this form is an
   * uncontrolled input with a defaultValue, because nothing depends on it while
   * it is being typed.
   */
  const [prices, setPrices] = useState({
    unit_price: box(product?.unit_price ?? 0),
    unit_cost: box(product?.unit_cost ?? 0),
    price_showroom: box(product?.price_showroom),
    price_wholesale: box(product?.price_wholesale),
    piece_price_retail: box(product?.piece_price_retail),
    piece_price_showroom: box(product?.piece_price_showroom),
    piece_price_wholesale: box(product?.piece_price_wholesale),
    pallet_price_retail: box(product?.pallet_price_retail),
    pallet_price_wholesale: box(product?.pallet_price_wholesale),
    piece_cost: box(product?.piece_cost),
    pallet_cost: box(product?.pallet_cost),
    case_pack: box(product?.case_pack),
  })
  const [currency, setCurrency] = useState(product?.currency ?? defaultCurrency)

  const set = (key: keyof typeof prices) => (value: string) =>
    setPrices((current) => ({ ...current, [key]: value }))

  // Two passes over the same rule. The first ignores the unit overrides, so the
  // showroom and wholesale boxes can offer what they would say on their own.
  // The second honours them, so a piece price divides the price that is
  // actually in force rather than one nobody chose.
  const auto = derivePricing({ unit_price: prices.unit_price, case_pack: prices.case_pack })
  const effective = derivePricing({
    unit_price: prices.unit_price,
    price_showroom: prices.price_showroom,
    price_wholesale: prices.price_wholesale,
    case_pack: prices.case_pack,
  })

  const showroom = showroomMargin(prices)
  const wholesale = wholesaleMargin(prices)

  // Scoped to this record's own options, not just the key — see optionsForField.
  const optionsFor = (key: string) => optionsForField(fieldOptions, 'product', key)

  const forCard = (card: string) => customFields.filter((field) => field.card === card)
  const cardDescription = (key: string) =>
    PRODUCT_CARDS.find((card) => card.key === key)?.description

  return (
    <form action={formAction} className="space-y-5">
      {product && <input type="hidden" name="id" value={product.id} />}

      {state.error && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          Saved.
        </p>
      )}

      <FormCard title="Product details" description={cardDescription('details')}>
        <div>
          <label className="label" htmlFor="name">
            Product Name
          </label>
          <input id="name" name="name" required className="input" defaultValue={product?.name ?? ''} />
        </div>

        <div>
          <label className="label" htmlFor="sku">
            SKU
          </label>
          <input
            id="sku"
            name="sku"
            className="input"
            placeholder="SHEA-25KG"
            defaultValue={product?.sku ?? ''}
          />
        </div>

        <div>
          <label className="label" htmlFor="brand">
            Brand
          </label>
          <input id="brand" name="brand" className="input" defaultValue={product?.brand ?? ''} />
        </div>

        <div>
          <label className="label" htmlFor="model">
            Model
          </label>
          <input id="model" name="model" className="input" defaultValue={product?.model ?? ''} />
        </div>

        <div>
          <label className="label" htmlFor="item_count">
            Count
          </label>
          <input
            id="item_count"
            name="item_count"
            className="input"
            placeholder="24 ct, 500 ml…"
            defaultValue={product?.item_count ?? ''}
          />
        </div>

        <div>
          <label className="label" htmlFor="size">
            Size
          </label>
          <input id="size" name="size" className="input" defaultValue={product?.size ?? ''} />
        </div>

        <div>
          <label className="label" htmlFor="color">
            Color
          </label>
          <input id="color" name="color" className="input" defaultValue={product?.color ?? ''} />
        </div>

        <div>
          <label className="label" htmlFor="case_pack">
            Case Pack
          </label>
          <input
            id="case_pack"
            name="case_pack"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            className="input"
            value={prices.case_pack}
            onChange={(event) => set('case_pack')(event.target.value)}
          />
          <Hint>Pieces to a unit. Divides the unit prices into piece prices.</Hint>
        </div>

        <OptionSelect
          name="product_type"
          label="Product Type"
          options={optionsFor('product_type')}
          value={product?.product_type ?? ''}
        />

        <OptionSelect
          name="product_condition"
          label="Condition"
          options={optionsFor('product_condition')}
          value={product?.product_condition ?? ''}
        />

        <OptionSelect
          name="status"
          label="Status"
          options={optionsFor('product_status')}
          value={product?.status ?? PRODUCT_ACTIVE_STATUS}
          required
          hint={`Only ${PRODUCT_ACTIVE_STATUS} products are offered on new deals. Deals that already list it keep it.`}
        />

        <div>
          <label className="label" htmlFor="folder_url">
            Folder Location
          </label>
          <input
            id="folder_url"
            name="folder_url"
            type="url"
            className="input"
            placeholder="https://…"
            defaultValue={product?.folder_url ?? ''}
          />
          <Hint>Where the paperwork lives.</Hint>
        </div>

        <div>
          <label className="label" htmlFor="knowledge_base_url">
            Knowledge Base
          </label>
          <input
            id="knowledge_base_url"
            name="knowledge_base_url"
            type="url"
            className="input"
            placeholder="https://…"
            defaultValue={product?.knowledge_base_url ?? ''}
          />
          <Hint>The spec sheet, the manual, the write-up.</Hint>
        </div>

        <div className="sm:col-span-2">
          <span className="label">Image</span>
          <ProductImageField currentUrl={productImageUrl(product?.image_path)} />
        </div>

        <div className="sm:col-span-2">
          <span className="label">Category</span>
          <RadioChips
            name="category"
            options={optionsFor('product_category')}
            selected={product?.category ?? null}
          />
        </div>

        {/*
          Chips, the same control the question gets on a contact and on a
          company. It is one question about how much something matters, and it
          should not look like three different questions depending on which
          record is open.
        */}
        <div className="sm:col-span-2">
          <span className="label">Priority</span>
          <RadioChips
            name="priority"
            options={optionsFor('priority')}
            selected={product?.priority ?? null}
          />
        </div>

        <div className="sm:col-span-2">
          <label className="label" htmlFor="item_notes">
            Item Notes
          </label>
          <NotesEditor
            id="item_notes"
            name="item_notes"
            defaultValue={product?.item_notes ?? ''}
            placeholder={'Anything worth knowing at a glance'}
          />
        </div>

        <CustomFieldInputs
          fields={forCard('details')}
          values={product?.custom_fields ?? {}}
          fieldOptions={fieldOptions}
        />

        {/*
          The same tags a contact and a company carry, not a catalogue-only
          vocabulary — "Q4 push" is worth nothing if it means one thing on an
          account and another on the line being pushed.

          The marker field tells the action this form asked the question: an
          empty checklist posts nothing, and without it an untagged save would
          be indistinguishable from a screen that never offered it.
        */}
        <div className="sm:col-span-2">
          <span className="label">Tags</span>
          <input type="hidden" name="tags_present" value="1" />
          <TagPicker tags={tags} selected={selectedTagIds} canManage={canManage} />
        </div>
      </FormCard>

      <FormSection>Pricing</FormSection>

      <FormCard title="Pricing" description={cardDescription('pricing')} columns={3}>
        <MoneyField
          name="unit_price"
          label="Unit $: Retail"
          hint="Drives Showroom & Wholesale"
          value={prices.unit_price}
          onChange={set('unit_price')}
        />
        <MoneyField
          name="price_showroom"
          label="Unit $: Showroom"
          hint="Auto 70% of Retail · editable"
          value={prices.price_showroom}
          auto={auto.unit.showroom.value}
          onChange={set('price_showroom')}
        />
        <MoneyField
          name="price_wholesale"
          label="Unit $: Wholesale"
          hint="Auto 30% of Retail · editable"
          value={prices.price_wholesale}
          auto={auto.unit.wholesale.value}
          onChange={set('price_wholesale')}
        />

        <div>
          <label className="label" htmlFor="currency">
            Currency
          </label>
          <select
            id="currency"
            name="currency"
            className="input"
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <Hint>A default. A line item is always priced in its own deal&rsquo;s currency.</Hint>
        </div>

        <MarginReadout
          label="Showroom Margin"
          margin={showroom}
          currency={currency}
          hint="Showroom price less unit cost"
        />

        <MarginReadout
          label="Wholesale Margin"
          margin={wholesale}
          currency={currency}
          hint="Wholesale price less unit cost"
        />

        <CustomFieldInputs
          fields={forCard('pricing')}
          values={product?.custom_fields ?? {}}
          fieldOptions={fieldOptions}
        />
      </FormCard>

      <FormCard title="Cost" description="What it costs us at each quantity" columns={3}>
        <MoneyField
          name="unit_cost"
          label="Unit $: Cost"
          hint="Fixed unit cost"
          value={prices.unit_cost}
          onChange={set('unit_cost')}
        />
        <MoneyField
          name="piece_cost"
          label="Piece $: Cost"
          hint="Optional"
          value={prices.piece_cost}
          onChange={set('piece_cost')}
        />
        <MoneyField
          name="pallet_cost"
          label="Pallet $: Cost"
          hint="Optional"
          value={prices.pallet_cost}
          onChange={set('pallet_cost')}
        />
      </FormCard>

      <FormCard
        title="Additional Pricing"
        description="The same three levels, by the piece and by the pallet"
        columns={3}
      >
        <MoneyField
          name="piece_price_retail"
          label="Piece $: Retail"
          hint="Auto: Unit Retail ÷ Case Pack"
          value={prices.piece_price_retail}
          auto={effective.piece.retail.value}
          onChange={set('piece_price_retail')}
        />
        <MoneyField
          name="piece_price_showroom"
          label="Piece $: Showroom"
          hint="Auto: Unit Showroom ÷ Case Pack"
          value={prices.piece_price_showroom}
          auto={effective.piece.showroom.value}
          onChange={set('piece_price_showroom')}
        />
        <MoneyField
          name="piece_price_wholesale"
          label="Piece $: Wholesale"
          hint="Auto: Unit Wholesale ÷ Case Pack"
          value={prices.piece_price_wholesale}
          auto={effective.piece.wholesale.value}
          onChange={set('piece_price_wholesale')}
        />
        <MoneyField
          name="pallet_price_retail"
          label="Pallet $: Retail"
          hint="Optional"
          value={prices.pallet_price_retail}
          onChange={set('pallet_price_retail')}
        />
        <MoneyField
          name="pallet_price_wholesale"
          label="Pallet $: Wholesale"
          hint="Optional"
          value={prices.pallet_price_wholesale}
          onChange={set('pallet_price_wholesale')}
        />
      </FormCard>

      <FormCard
        title="In the Market"
        description="What everyone else is charging for it"
        columns={3}
      >
        <div>
          <label className="label" htmlFor="barcode_url">
            Barcode Lookup
          </label>
          <input
            id="barcode_url"
            name="barcode_url"
            type="url"
            className="input"
            placeholder="https://…"
            defaultValue={product?.barcode_url ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="comp_1_url">
            Comp 1
          </label>
          <input
            id="comp_1_url"
            name="comp_1_url"
            type="url"
            className="input"
            placeholder="https://…"
            defaultValue={product?.comp_1_url ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="comp_2_url">
            Comp 2
          </label>
          <input
            id="comp_2_url"
            name="comp_2_url"
            type="url"
            className="input"
            placeholder="https://…"
            defaultValue={product?.comp_2_url ?? ''}
          />
        </div>
      </FormCard>

      <FormSection>Stock</FormSection>

      <FormCard title="Stock" description="How many there are, and where">
        <div className="sm:col-span-2">
          <StockEditor
            locations={locations}
            bins={bins}
            defaultValue={stock}
            committed={committed}
          />
        </div>
      </FormCard>

      <FormCard title="Additional info" description={cardDescription('additional')}>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="description">
            Description
          </label>
          <NotesEditor
            id="description"
            name="description"
            defaultValue={product?.description ?? ''}
            placeholder={'Specification, origin, certifications…'}
          />
        </div>

        <CustomFieldInputs
          fields={forCard('additional')}
          values={product?.custom_fields ?? {}}
          fieldOptions={fieldOptions}
        />
      </FormCard>

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </button>
        <Link href={product ? `/products/${product.id}` : '/products'} className="btn-secondary">
          Cancel
        </Link>
      </div>
    </form>
  )
}
