'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'

import type { RevisedRateType } from '@/lib/database.types'
import { lineTotal } from '@/lib/sales'
import { formatPrice } from '@/lib/format'
import { TrashIcon } from '@/components/icons'
import {
  addSalesOrderLine,
  removeSalesOrderLine,
  updateSalesOrderLine,
} from '@/app/(app)/sales-orders/actions'

/**
 * The lines of a sales order, edited where they are read.
 *
 * One block per line rather than a row in a table: a line carries eight fields
 * and a note, and eight columns of inputs across a table is a shape that only
 * works on a monitor. Each block lays them out in a row that wraps, with the
 * note underneath it — which is what the attachment this was built from does.
 *
 * Nothing is saved by a Save button. A field writes when it is left, the same
 * bargain the lists make: the total beside it recomputes as you type, so the
 * arithmetic is visible before the write lands, and the server's answer
 * replaces it a moment later. `lib/sales` does that arithmetic, which is the
 * same module the page's totals use and a mirror of the SQL that derives the
 * stored value — the number on screen and the number in the database follow
 * one rule.
 */

export interface LineProduct {
  id: string
  name: string
  sku: string | null
  unit: string | null
}

export interface EditableLine {
  id: string
  productId: string | null
  description: string | null
  unit: string | null
  quantity: number
  unitPrice: number
  unitCost: number
  revisedRateType: RevisedRateType | null
  revisedRate: number | null
  notes: string | null
  lineTotal: number
}

/** What a line's fields hold while somebody is typing into them. */
interface Draft {
  productId: string
  description: string
  unit: string
  quantity: string
  unitPrice: string
  unitCost: string
  revisedRateType: string
  revisedRate: string
  notes: string
}

function draftOf(line: EditableLine): Draft {
  return {
    productId: line.productId ?? '',
    description: line.description ?? '',
    unit: line.unit ?? '',
    quantity: String(line.quantity),
    unitPrice: String(line.unitPrice),
    unitCost: String(line.unitCost),
    revisedRateType: line.revisedRateType ?? '',
    revisedRate: line.revisedRate === null ? '' : String(line.revisedRate),
    notes: line.notes ?? '',
  }
}

/** The draft as the action wants it — one line, whole, every time. */
function formOf(draft: Draft, orderId: string, id?: string): FormData {
  const form = new FormData()
  if (id) form.set('id', id)
  form.set('sales_order_id', orderId)
  form.set('product_id', draft.productId)
  form.set('description', draft.description)
  form.set('unit', draft.unit)
  form.set('quantity', draft.quantity || '0')
  form.set('unit_price', draft.unitPrice || '0')
  form.set('unit_cost', draft.unitCost || '0')
  form.set('revised_rate_type', draft.revisedRateType)
  form.set('revised_rate', draft.revisedRate)
  form.set('notes', draft.notes)
  return form
}

const num = (value: string) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/* -------------------------------------------------------------------------- */

/**
 * The item field, and the one thing it has to make obvious.
 *
 * A line is either something in the catalogue or something that is not, and
 * those are different in ways that matter later — stock comes off one and not
 * the other, and a margin needs a cost the catalogue knows. So the field says
 * which it is: a match is picked from the list, and typing something with no
 * match offers to use it as a non-inventoried item rather than silently
 * accepting a name the catalogue has never heard of.
 */
function ItemField({
  products,
  productId,
  description,
  onPick,
  onDescribe,
  disabled,
}: {
  products: LineProduct[]
  productId: string
  description: string
  onPick: (product: LineProduct) => void
  onDescribe: (description: string) => void
  disabled: boolean
}) {
  const chosen = products.find((one) => one.id === productId)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return products.slice(0, 8)
    return products
      .filter(
        (one) =>
          one.name.toLowerCase().includes(needle) ||
          (one.sku ?? '').toLowerCase().includes(needle),
      )
      .slice(0, 8)
  }, [products, search])

  // What the field shows when nobody is typing into it: the catalogue name, or
  // the words somebody used for a line the catalogue does not have.
  const settled = chosen?.name ?? description

  if (disabled) {
    return <span className="block truncate text-sm text-slate-700">{settled || '—'}</span>
  }

  return (
    <div ref={box} className="relative">
      <input
        className="input"
        placeholder="Type to search items…"
        value={open ? search : settled}
        onFocus={() => {
          setSearch(settled)
          setOpen(true)
        }}
        onChange={(event) => {
          setSearch(event.target.value)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          // Enter takes the single match, or the typed words if there is none.
          if (event.key !== 'Enter') return
          event.preventDefault()
          if (matches.length === 1) {
            onPick(matches[0])
          } else if (search.trim()) {
            onDescribe(search.trim())
          }
          setOpen(false)
        }}
      />

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
          {matches.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-slate-400">No items match.</p>
          )}

          {matches.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => {
                onPick(product)
                setOpen(false)
              }}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50"
            >
              <span className="min-w-0 truncate text-slate-700">{product.name}</span>
              {product.sku && (
                <span className="shrink-0 text-xs text-slate-400">{product.sku}</span>
              )}
            </button>
          ))}

          {/*
            The other kind of line, offered rather than assumed. Freight, a
            pallet fee, a one-off nobody will ever stock — real lines that the
            catalogue should not grow a row for.
          */}
          {search.trim() && (
            <button
              type="button"
              onClick={() => {
                onDescribe(search.trim())
                setOpen(false)
              }}
              className="mt-1 flex w-full items-center gap-1.5 rounded-lg border-t border-slate-100 px-2 py-1.5 text-left text-sm text-brand-700 hover:bg-brand-50"
            >
              <span className="text-base leading-none">+</span>
              Use &ldquo;{search.trim()}&rdquo; as a non-inventoried item
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function LineBlock({
  line,
  orderId,
  currency,
  products,
  units,
  editable,
}: {
  line: EditableLine
  orderId: string
  currency: string
  products: LineProduct[]
  units: string[]
  editable: boolean
}) {
  const [draft, setDraft] = useState(() => draftOf(line))
  const [error, setError] = useState<string | null>(null)
  const [saving, startTransition] = useTransition()

  /*
   * Whatever the server last said wins, once it has said it. Compared by
   * content: the page re-renders after every save and a fresh object holding
   * the same answer is the same answer.
   */
  const settled = JSON.stringify(draftOf(line))
  useEffect(() => {
    setDraft(JSON.parse(settled) as Draft)
  }, [settled])

  const save = (next: Draft) => {
    setError(null)
    startTransition(async () => {
      const result = await updateSalesOrderLine({}, formOf(next, orderId, line.id))
      if (result.error) setError(result.error)
    })
  }

  /* Live, from the same function the database's derivation mirrors. */
  const total = lineTotal(
    num(draft.quantity),
    num(draft.unitPrice),
    (draft.revisedRateType || null) as RevisedRateType | null,
    draft.revisedRate === '' ? null : num(draft.revisedRate),
  )

  const set = (patch: Partial<Draft>) => setDraft((was) => ({ ...was, ...patch }))
  /** Typing settles on blur; picking from a list settles immediately. */
  const commit = (patch: Partial<Draft>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    save(next)
  }

  const product = products.find((one) => one.id === draft.productId)
  const unitHint = draft.unit || product?.unit || ''

  return (
    <div
      className={`rounded-xl border border-slate-200 p-3 transition-opacity ${
        saving ? 'opacity-60' : ''
      }`}
    >
      <div className="grid gap-3 sm:grid-cols-12">
        <div className="sm:col-span-4">
          <label className="label">Item</label>
          <ItemField
            products={products}
            productId={draft.productId}
            description={draft.description}
            disabled={!editable}
            onPick={(picked) =>
              /* The catalogue answers three questions at once: which product,
                 what it is called, and what it is counted in. */
              commit({
                productId: picked.id,
                description: '',
                unit: draft.unit || picked.unit || '',
              })
            }
            onDescribe={(words) => commit({ productId: '', description: words })}
          />
        </div>

        <div className="sm:col-span-2">
          <label className="label">UoM</label>
          {editable ? (
            <select
              className="input"
              value={unitHint}
              onChange={(event) => commit({ unit: event.target.value })}
            >
              <option value="">—</option>
              {units.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          ) : (
            <span className="block text-sm text-slate-700">{unitHint || '—'}</span>
          )}
        </div>

        <div className="sm:col-span-1">
          <label className="label">Qty</label>
          <NumberBox
            value={draft.quantity}
            editable={editable}
            onChange={(value) => set({ quantity: value })}
            onSettle={() => save(draft)}
          />
        </div>

        <div className="sm:col-span-2">
          <label className="label">Unit Price</label>
          <NumberBox
            value={draft.unitPrice}
            editable={editable}
            step="0.01"
            onChange={(value) => set({ unitPrice: value })}
            onSettle={() => save(draft)}
          />
        </div>

        {/* A revision is a pair: a kind and a value. The database refuses half
            of one, and the discount follows from both. */}
        <div className="sm:col-span-2">
          <label className="label">Revised Rate</label>
          <div className="flex gap-1">
            <NumberBox
              value={draft.revisedRate}
              editable={editable}
              step="0.01"
              placeholder="—"
              onChange={(value) => set({ revisedRate: value })}
              onSettle={() =>
                save({
                  ...draft,
                  // A value with no kind is half a pair. Percent is the one
                  // people mean when they type a number into this box.
                  revisedRateType:
                    draft.revisedRate === '' ? '' : draft.revisedRateType || 'percent',
                })
              }
            />
            {editable && (
              <select
                aria-label="Revised rate kind"
                className="input w-16 px-2"
                value={draft.revisedRateType || 'percent'}
                onChange={(event) => {
                  /*
                   * Only worth writing once there is a rate to apply it to. A
                   * kind on its own is half a pair, which the schema and the
                   * database both refuse — and being told off for choosing $
                   * before typing a number would be the app's fault, not the
                   * person's.
                   */
                  const kind = event.target.value
                  if (draft.revisedRate === '') set({ revisedRateType: kind })
                  else commit({ revisedRateType: kind })
                }}
              >
                <option value="percent">%</option>
                <option value="fixed">$</option>
              </select>
            )}
          </div>
        </div>

        <div className="sm:col-span-1">
          <label className="label">Line Total</label>
          <p className="py-2 text-right text-sm font-medium text-slate-900">
            {formatPrice(total, currency)}
          </p>
        </div>
      </div>

      <div className="mt-2 flex items-start gap-2">
        {editable ? (
          <input
            className="input flex-1 text-sm"
            placeholder="Add a note for this line (optional)…"
            value={draft.notes}
            onChange={(event) => set({ notes: event.target.value })}
            onBlur={() => save(draft)}
          />
        ) : (
          draft.notes && <p className="flex-1 text-xs text-slate-500">{draft.notes}</p>
        )}

        {editable && (
          <button
            type="button"
            aria-label="Remove this line"
            title="Remove this line"
            onClick={() => {
              const form = new FormData()
              form.set('id', line.id)
              form.set('sales_order_id', orderId)
              startTransition(async () => {
                const result = await removeSalesOrderLine({}, form)
                if (result.error) setError(result.error)
              })
            }}
            className="rounded-lg p-2 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-600"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
      </div>

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

/** A number box that keeps what was typed until the field is left. */
function NumberBox({
  value,
  onChange,
  onSettle,
  editable,
  step = '1',
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  onSettle: () => void
  editable: boolean
  step?: string
  placeholder?: string
}) {
  if (!editable) {
    return <span className="block py-2 text-sm text-slate-700">{value || '—'}</span>
  }
  return (
    <input
      type="number"
      step={step}
      min="0"
      className="input"
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onSettle}
    />
  )
}

/* -------------------------------------------------------------------------- */

export function SalesOrderLines({
  orderId,
  currency,
  lines,
  products,
  units,
  editable,
}: {
  orderId: string
  currency: string
  lines: EditableLine[]
  products: LineProduct[]
  /** The units this organization actually uses, drawn from its catalogue. */
  units: string[]
  editable: boolean
}) {
  const [adding, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="space-y-3">
      {lines.length === 0 && (
        <p className="text-sm text-slate-500">
          Nothing on this order yet. Add a product, or a line of your own.
        </p>
      )}

      {lines.map((line) => (
        <LineBlock
          key={line.id}
          line={line}
          orderId={orderId}
          currency={currency}
          products={products}
          units={units}
          editable={editable}
        />
      ))}

      {editable && (
        <>
          <button
            type="button"
            disabled={adding}
            onClick={() => {
              setError(null)
              /*
               * An empty line, immediately. The alternative — a form to fill in
               * before anything appears — is the thing this card was rebuilt to
               * get rid of: the row is the form.
               */
              const form = new FormData()
              form.set('sales_order_id', orderId)
              form.set('description', 'New line')
              form.set('quantity', '1')
              form.set('unit_price', '0')
              form.set('unit_cost', '0')
              startTransition(async () => {
                const result = await addSalesOrderLine({}, form)
                if (result.error) setError(result.error)
              })
            }}
            className="btn-secondary"
          >
            <span className="text-base leading-none">+</span>
            {adding ? 'Adding…' : 'Add line'}
          </button>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </>
      )}
    </div>
  )
}
