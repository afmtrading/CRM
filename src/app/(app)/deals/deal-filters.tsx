'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useActionState, useEffect, useState } from 'react'

import type { SavedFilterRow } from '@/lib/database.types'

import { deleteDealView, saveDealView } from './actions'
import type { ActionState } from '@/components/action-form'

/**
 * The deals board's own filter row.
 *
 * Not the shared `FilterBar`: that offers grouping, sorting and export, none of
 * which a kanban can honour, and its conditions are column predicates on one
 * table — so it could never express "has this product", which lives across a
 * join. Three pickers and a save box answer what people actually ask of a
 * board, and the state stays in the URL, which is what makes a filtered board
 * shareable by pasting the address.
 */

/**
 * Status, worded as a question about what to show rather than as the values in
 * the column. "Open and closed" is a sentence; `status=` with a blank value is
 * a puzzle.
 */
export const STATUS_OPTIONS = [
  { value: 'open', label: 'Open deals' },
  { value: 'all', label: 'Open and closed' },
  { value: 'won', label: 'Won only' },
  { value: 'lost', label: 'Lost only' },
]

export function DealFilters({
  owners,
  products,
  savedViews,
  currentUserId,
}: {
  owners: { id: string; name: string }[]
  products: { id: string; name: string }[]
  savedViews: SavedFilterRow[]
  currentUserId: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [naming, setNaming] = useState(false)
  const [saveState, saveAction, savingView] = useActionState(saveDealView, {} as ActionState)

  // Closing on success rather than on submit. Closing on submit is what this
  // did, which took the refusal off screen at the moment it arrived.
  useEffect(() => {
    if (saveState.ok) setNaming(false)
  }, [saveState.ok])

  const current = {
    owner: searchParams.get('owner') ?? '',
    product: searchParams.get('product') ?? '',
    status: searchParams.get('status') ?? 'open',
  }

  const filtered = Boolean(current.owner || current.product || current.status !== 'open')

  function set(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    router.push(`?${next.toString()}`)
  }

  /*
   * A saved view remembers the filters and which board they were on, but not
   * kanban-versus-list — that is a preference about how you are reading today,
   * not part of the view itself.
   */
  const VIEW_KEYS = ['pipeline', 'owner', 'product', 'status']

  const viewParams = () => {
    const next = new URLSearchParams()
    for (const key of VIEW_KEYS) {
      const value = searchParams.get(key)
      if (value) next.set(key, value)
    }
    return next.toString()
  }

  const hrefFor = (filter: unknown) => {
    const record = (filter ?? {}) as Record<string, string>
    const next = new URLSearchParams()
    for (const key of VIEW_KEYS) if (record[key]) next.set(key, record[key])
    return `?${next.toString()}`
  }

  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Show"
          className="input w-44 py-1.5 text-sm"
          value={current.status}
          onChange={(event) => set('status', event.target.value)}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          aria-label="Owner"
          className="input w-44 py-1.5 text-sm"
          value={current.owner}
          onChange={(event) => set('owner', event.target.value)}
        >
          <option value="">Everyone&apos;s deals</option>
          <option value={currentUserId}>Mine</option>
          {owners
            .filter((owner) => owner.id !== currentUserId)
            .map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
        </select>

        <select
          aria-label="Product"
          className="input w-48 py-1.5 text-sm"
          value={current.product}
          onChange={(event) => set('product', event.target.value)}
        >
          <option value="">Any product</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>

        {filtered && (
          <button
            type="button"
            className="text-xs text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
            onClick={() => {
              const next = new URLSearchParams()
              const pipeline = searchParams.get('pipeline')
              const view = searchParams.get('view')
              if (pipeline) next.set('pipeline', pipeline)
              if (view) next.set('view', view)
              router.push(`?${next.toString()}`)
            }}
          >
            Clear
          </button>
        )}

        {/* Only offered once there is something worth remembering. */}
        {filtered && !naming && (
          <button
            type="button"
            className="ml-auto text-xs font-medium text-brand-700 hover:underline"
            onClick={() => setNaming(true)}
          >
            Save this view
          </button>
        )}
      </div>

      {naming && (
        <div>
          <form action={saveAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="params" value={viewParams()} />
            <input
              name="name"
              required
              maxLength={80}
              autoFocus
              placeholder="Name this view — “My open EU deals”"
              className="input w-72 py-1.5 text-sm"
            />
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" name="is_shared" className="h-3.5 w-3.5" />
              Share with the team
            </label>
            <button type="submit" className="btn-secondary px-2.5 py-1 text-xs" disabled={savingView}>
              {savingView ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="text-xs text-slate-500 hover:text-slate-800"
              onClick={() => setNaming(false)}
            >
              Cancel
            </button>
          </form>

          {saveState.error && (
            <p role="status" className="mt-1 text-xs text-red-700">
              {saveState.error}
            </p>
          )}
        </div>
      )}

      {savedViews.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-400">Views</span>
          {savedViews.map((saved) => (
            <span
              key={saved.id}
              className="group inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white py-0.5 pr-1 pl-2.5 text-xs text-slate-600 hover:border-slate-300"
            >
              <a href={hrefFor(saved.filter_json)} className="hover:text-brand-700">
                {saved.name}
              </a>
              {saved.user_id === currentUserId && (
                <form action={deleteDealView}>
                  <input type="hidden" name="id" value={saved.id} />
                  <button
                    type="submit"
                    aria-label={`Delete the ${saved.name} view`}
                    title={`Delete the ${saved.name} view`}
                    className="px-1 text-slate-300 hover:text-red-600"
                  >
                    ×
                  </button>
                </form>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
