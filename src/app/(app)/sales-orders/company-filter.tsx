'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

export interface FilterCompany {
  id: string
  name: string
}

/**
 * The company filter, as something you can type into.
 *
 * It was a plain select, which is fine at a dozen companies and unusable at
 * three hundred — the browser's own type-ahead only matches from the first
 * letter, so finding "A.T.I.L. (Total Inventory Liquidation)" means knowing it
 * starts with an A rather than knowing it is the liquidation one.
 *
 * The visible box is text; the value the form posts is a hidden input holding
 * the id, so the surrounding GET form and the filter reading `company` on the
 * server both work exactly as they did.
 */
export function CompanyFilter({
  companies,
  selected,
}: {
  companies: FilterCompany[]
  /** The id currently filtered on, or '' for every company. */
  selected: string
}) {
  const chosen = companies.find((company) => company.id === selected) ?? null

  const [id, setId] = useState(selected)
  const [search, setSearch] = useState(chosen?.name ?? '')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  /*
   * A click anywhere else closes the list. Without this the menu stays open
   * behind the next thing somebody reaches for, which on this form is the date
   * picker directly to its right.
   */
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    // Everything, when nothing has been typed — the list is the old select.
    if (!needle) return companies.slice(0, 50)
    return companies
      .filter((company) => company.name.toLowerCase().includes(needle))
      .slice(0, 50)
  }, [companies, search])

  /** Typing something that is nobody's name means the filter is cleared. */
  const type = (value: string) => {
    setSearch(value)
    setOpen(true)
    if (id) setId('')
  }

  return (
    <div ref={box} className="relative">
      <input type="hidden" name="company" value={id} />

      <input
        id="company"
        className="input"
        autoComplete="off"
        value={search}
        placeholder="Every company"
        onChange={(event) => type(event.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
          // The first match, without reaching for the mouse. Enter would
          // otherwise submit the form with nothing chosen.
          if (event.key === 'Enter' && open && matches[0]) {
            event.preventDefault()
            setId(matches[0].id)
            setSearch(matches[0].name)
            setOpen(false)
          }
        }}
      />

      {open && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-sm text-slate-500 hover:bg-slate-50"
            onClick={() => {
              setId('')
              setSearch('')
              setOpen(false)
            }}
          >
            Every company
          </button>

          {matches.map((company) => (
            <button
              key={company.id}
              type="button"
              className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${
                company.id === id ? 'font-medium text-brand-700' : 'text-slate-700'
              }`}
              onClick={() => {
                setId(company.id)
                setSearch(company.name)
                setOpen(false)
              }}
            >
              {company.name}
            </button>
          ))}

          {matches.length === 0 && (
            <p className="px-3 py-2 text-sm text-slate-400">No company matches that.</p>
          )}
        </div>
      )}
    </div>
  )
}
