'use client'

import { useActionState, useEffect, useState } from 'react'

import { addMarketplace } from './actions'
import type { ActionState } from '@/components/action-form'

/**
 * Promoting an existing company.
 *
 * There is no "new marketplace" form, on purpose. A marketplace is a company,
 * and a second way to create companies would be a second place for duplicates
 * to come from — the one thing this CRM already has a whole settings screen for
 * cleaning up. If the platform is not on file yet, it is added as a company
 * first, which is the same two clicks and leaves one record rather than two.
 *
 * The company list arrives as a prop rather than through a fetch. It is two
 * fields per row and bounded by the page, which is cheaper than an API route
 * that would need its own tenancy check to say the same thing.
 */
export function AddMarketplaceForm({
  companies,
}: {
  companies: { id: string; name: string }[]
}) {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(addMarketplace, {} as ActionState)
  const [search, setSearch] = useState('')

  // Closing on success rather than on submit: a refusal has to stay on screen
  // long enough to be read.
  useEffect(() => {
    if (state.ok) setOpen(false)
  }, [state.ok])

  const matches = companies.filter((company) =>
    company.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  return (
    <>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        Add marketplace
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <form
            action={formAction}
            className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
            aria-label="Add a marketplace"
          >
            <h2 className="mb-1 text-base font-semibold text-slate-900">Add a marketplace</h2>
            <p className="mb-4 text-xs text-slate-500">
              Pick the company that runs it. Its contacts, notes and history stay where they are —
              this adds what it costs to trade there.
            </p>

            {state.error && (
              <p className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {state.error}
              </p>
            )}

            <label className="label" htmlFor="marketplace-search">
              Company
            </label>
            <input
              id="marketplace-search"
              className="input mb-2"
              placeholder="Search companies…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />

            <select
              name="company_id"
              size={6}
              className="input mb-4 w-full"
              required
              aria-label="Company to add"
            >
              {matches.length === 0 && <option disabled>No companies match</option>}
              {matches.slice(0, 200).map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>

            <fieldset className="mb-4">
              <legend className="label">Used for</legend>
              <label className="flex items-center gap-2 py-1 text-sm text-slate-700">
                <input
                  type="checkbox"
                  name="sells_through"
                  defaultChecked
                  className="h-4 w-4 rounded border-slate-300"
                />
                Selling — you list inventory here
              </label>
              <label className="flex items-center gap-2 py-1 text-sm text-slate-700">
                <input
                  type="checkbox"
                  name="sources_from"
                  className="h-4 w-4 rounded border-slate-300"
                />
                Sourcing — you buy inventory here
              </label>
              <p className="mt-1 text-xs text-slate-400">
                Both, for an auction house that charges a seller&rsquo;s commission one way and a
                buyer&rsquo;s premium the other.
              </p>
            </fieldset>

            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={pending}>
                {pending ? 'Adding…' : 'Add'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
