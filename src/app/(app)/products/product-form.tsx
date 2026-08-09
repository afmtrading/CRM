'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'

import type {
  CustomFieldDefinitionRow,
  FieldOptionRow,
  ProductRow,
} from '@/lib/database.types'
import { CURRENCIES, formatCurrency } from '@/lib/format'
import { PRODUCT_CARDS } from '@/lib/field-options'
import { CustomFieldInputs, FormCard, NotesEditor, RadioChips } from '@/components/form-fields'

import type { ProductActionState } from './actions'

export function ProductForm({
  action,
  product,
  customFields,
  fieldOptions,
  defaultCurrency,
  submitLabel,
}: {
  action: (state: ProductActionState, formData: FormData) => Promise<ProductActionState>
  product?: ProductRow
  customFields: CustomFieldDefinitionRow[]
  fieldOptions: FieldOptionRow[]
  defaultCurrency: string
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as ProductActionState)

  // Margin is shown as it is typed rather than after saving: a price entered
  // below cost is a mistake worth catching in the moment.
  const [price, setPrice] = useState(product?.unit_price ?? 0)
  const [cost, setCost] = useState(product?.unit_cost ?? 0)
  const [currency, setCurrency] = useState(product?.currency ?? defaultCurrency)

  const margin = price - cost
  const marginPct = price > 0 ? Math.round((margin / price) * 100) : null

  const categoryOptions = fieldOptions.filter(
    (option) => option.entity_type === 'product' && option.field_key === 'product_category',
  )

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
            Name
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
          <label className="label" htmlFor="unit">
            Unit
          </label>
          <input
            id="unit"
            name="unit"
            className="input"
            placeholder="kg, MT, container…"
            defaultValue={product?.unit ?? ''}
          />
          <p className="mt-1 text-xs text-slate-400">What a quantity on a deal counts.</p>
        </div>

        <div>
          <span className="label">Category</span>
          <RadioChips name="category" options={categoryOptions} selected={product?.category ?? null} />
        </div>

        <div className="sm:col-span-2">
          <label className="flex items-center gap-2.5 text-sm text-slate-700">
            <input
              type="checkbox"
              name="active"
              defaultChecked={product ? product.active : true}
              className="h-4 w-4 rounded border-slate-300"
            />
            Active — offered on new deals
          </label>
          <p className="mt-1 text-xs text-slate-400">
            Retiring a product hides it from the picker without touching the deals that already list
            it.
          </p>
        </div>

        <CustomFieldInputs
          fields={forCard('details')}
          values={product?.custom_fields ?? {}}
          fieldOptions={fieldOptions}
        />
      </FormCard>

      <FormCard title="Pricing" description={cardDescription('pricing')}>
        <div>
          <label className="label" htmlFor="unit_price">
            Price per unit
          </label>
          <input
            id="unit_price"
            name="unit_price"
            type="number"
            step="0.01"
            min="0"
            className="input"
            value={price}
            onChange={(event) => setPrice(Number(event.target.value))}
          />
        </div>

        <div>
          <label className="label" htmlFor="unit_cost">
            Cost per unit
          </label>
          <input
            id="unit_cost"
            name="unit_cost"
            type="number"
            step="0.01"
            min="0"
            className="input"
            value={cost}
            onChange={(event) => setCost(Number(event.target.value))}
          />
        </div>

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
          <p className="mt-1 text-xs text-slate-400">
            A default. A line item is always priced in its own deal&rsquo;s currency.
          </p>
        </div>

        <div>
          <span className="label">Margin</span>
          <p
            className={`mt-1 text-sm font-medium ${
              margin < 0 ? 'text-red-600' : 'text-slate-800'
            }`}
          >
            {formatCurrency(margin, currency)}
            {marginPct !== null && (
              <span className="ml-2 text-xs font-normal text-slate-500">{marginPct}%</span>
            )}
          </p>
          {margin < 0 && <p className="mt-1 text-xs text-red-600">The price is below cost.</p>}
        </div>

        <CustomFieldInputs
          fields={forCard('pricing')}
          values={product?.custom_fields ?? {}}
          fieldOptions={fieldOptions}
        />
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
