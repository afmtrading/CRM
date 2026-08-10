'use client'

import { useState } from 'react'

import type { ProductRow } from '@/lib/database.types'
import { formatCurrency } from '@/lib/format'
import { PlusIcon } from '@/components/icons'

/**
 * The "add a product" row on a deal.
 *
 * Choosing a product copies its price and cost into the form, where they can
 * still be changed before saving. From that point the line keeps whatever was
 * entered — re-pricing the catalogue later never rewrites a deal.
 */
export function AddLineItem({
  dealId,
  dealCurrency,
  products,
  action,
}: {
  dealId: string
  dealCurrency: string
  products: ProductRow[]
  action: (formData: FormData) => void
}) {
  const [productId, setProductId] = useState('')
  const [price, setPrice] = useState('')
  const [cost, setCost] = useState('')

  const selected = products.find((product) => product.id === productId)
  const currencyDiffers = selected != null && selected.currency !== dealCurrency

  function choose(id: string) {
    setProductId(id)
    const product = products.find((candidate) => candidate.id === id)
    setPrice(product ? String(product.unit_price) : '')
    setCost(product ? String(product.unit_cost) : '')
  }

  if (products.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No active products to add. An administrator or manager can add them under Products.
      </p>
    )
  }

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-12">
      <input type="hidden" name="deal_id" value={dealId} />
      <input type="hidden" name="unit_cost" value={cost} />

      <div className="sm:col-span-5">
        <label className="label" htmlFor="line-product">
          Product
        </label>
        <select
          id="line-product"
          name="product_id"
          required
          className="input"
          value={productId}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="">Choose a product…</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
              {product.unit ? ` (per ${product.unit})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor="line-quantity">
          Quantity
        </label>
        <input
          id="line-quantity"
          name="quantity"
          type="number"
          step="0.001"
          min="0"
          required
          defaultValue="1"
          className="input"
        />
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor="line-price">
          Price ({dealCurrency})
        </label>
        <input
          id="line-price"
          name="unit_price"
          type="number"
          step="0.01"
          min="0"
          required
          className="input"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </div>

      <div className="sm:col-span-1">
        <label className="label" htmlFor="line-discount">
          Disc %
        </label>
        <input
          id="line-discount"
          name="discount_pct"
          type="number"
          step="0.01"
          min="0"
          max="100"
          defaultValue="0"
          className="input"
        />
      </div>

      <div className="flex items-end sm:col-span-2">
        <button type="submit" className="btn-primary w-full">
          <PlusIcon className="h-4 w-4" />
          Add
        </button>
      </div>

      {currencyDiffers && (
        <p className="text-xs text-amber-700 sm:col-span-12">
          {selected!.name} is priced in {selected!.currency} and this deal is in {dealCurrency}. The
          figure above was copied across unconverted — check it before adding.
        </p>
      )}

      {selected && (
        <p className="text-xs text-slate-400 sm:col-span-12">
          Catalogue price {formatCurrency(Number(selected.unit_price), selected.currency)}
          {selected.unit ? ` per ${selected.unit}` : ''}.
        </p>
      )}
    </form>
  )
}
