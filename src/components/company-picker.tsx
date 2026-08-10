'use client'

import { useMemo, useRef, useState } from 'react'

import { PlusIcon, SearchIcon } from '@/components/icons'

/**
 * Company picker with a search box and an escape hatch.
 *
 * A plain <select> stops being usable somewhere around fifty companies, and it
 * offers nothing when the company simply is not there yet. This filters as you
 * type and, when nothing matches, offers to create the company from whatever
 * was typed — the contact and the company are then saved together, so the flow
 * is never interrupted to go and create one first.
 *
 * Posts either `company_id` (an existing company) or `new_company_name` (one to
 * create). Never both.
 */
export function CompanyPicker({
  companies,
  defaultValue,
}: {
  companies: { id: string; name: string }[]
  defaultValue?: string | null
}) {
  const selectedInitially = companies.find((company) => company.id === defaultValue) ?? null

  const [selected, setSelected] = useState(selectedInitially)
  // Set when creating a company that does not exist yet.
  const [pendingName, setPendingName] = useState('')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase()
    const list = term
      ? companies.filter((company) => company.name.toLowerCase().includes(term))
      : companies
    return list.slice(0, 8)
  }, [companies, query])

  const trimmed = query.trim()
  const exactMatch = companies.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())

  function choose(company: { id: string; name: string } | null) {
    setSelected(company)
    setPendingName('')
    setQuery('')
    setOpen(false)
  }

  function createFromQuery() {
    setPendingName(trimmed)
    setSelected(null)
    setQuery('')
    setOpen(false)
  }

  // Closing on blur is deferred so a click on an option registers first.
  function deferClose() {
    blurTimer.current = setTimeout(() => setOpen(false), 120)
  }
  function cancelClose() {
    if (blurTimer.current) clearTimeout(blurTimer.current)
  }

  return (
    <div className="relative">
      <input type="hidden" name="company_id" value={selected?.id ?? ''} />
      <input type="hidden" name="new_company_name" value={pendingName} />

      {selected || pendingName ? (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
            {selected ? selected.name : pendingName}
            {pendingName && (
              <span className="ml-2 text-xs text-brand-700">will be created</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              choose(null)
              setOpen(true)
            }}
            className="shrink-0 text-xs text-slate-400 hover:text-slate-700"
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              className="input pl-9"
              placeholder="Search companies…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              onBlur={deferClose}
              role="combobox"
              aria-expanded={open}
              aria-controls="company-picker-list"
              aria-label="Company"
            />
          </div>

          {open && (
            <ul
              id="company-picker-list"
              className="card absolute z-30 mt-1 max-h-64 w-full overflow-y-auto p-1"
              onMouseDown={cancelClose}
            >
              {matches.map((company) => (
                <li key={company.id}>
                  <button
                    type="button"
                    onClick={() => choose(company)}
                    className="w-full truncate rounded-lg px-2.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                  >
                    {company.name}
                  </button>
                </li>
              ))}

              {matches.length === 0 && !trimmed && (
                <li className="px-2.5 py-2 text-sm text-slate-500">No companies yet.</li>
              )}

              {trimmed && !exactMatch && (
                <li className={matches.length > 0 ? 'mt-1 border-t border-slate-100 pt-1' : ''}>
                  <button
                    type="button"
                    onClick={createFromQuery}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-brand-700 hover:bg-brand-50"
                  >
                    <PlusIcon className="h-4 w-4 shrink-0" />
                    <span className="truncate">Create “{trimmed}”</span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
