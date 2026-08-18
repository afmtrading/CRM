'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { SearchIcon } from '@/components/icons'

export interface SearchOption {
  id: string
  label: string
  /** A second line under the label — a company under a person, say. */
  hint?: string
}

/**
 * A single-select you can type into.
 *
 * A plain <select> is fine for ten options and unusable for five hundred:
 * there is nothing to type into, so finding a company means scrolling a list
 * in the browser's own popup with no idea how long it is.
 *
 * Deliberately cannot create. CompanyPicker can, because a contact arriving
 * from a new business is the ordinary case there. A deal is raised against a
 * company you already deal with, and offering to invent one from a typo is a
 * way to end up with two of them.
 *
 * Posts one hidden input, so it drops into a form in place of the select it
 * replaces without the surrounding code changing.
 */
export function SearchSelect({
  name,
  options,
  value,
  onChange,
  placeholder = 'Search…',
  emptyLabel = '—',
  disabled = false,
  disabledHint,
  id,
}: {
  name: string
  options: SearchOption[]
  /** Controlled, so two of these can depend on each other. */
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** What the cleared state reads as. */
  emptyLabel?: string
  disabled?: boolean
  /** Why it is disabled, shown in place of the search box. */
  disabledHint?: string
  id?: string
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const selected = useMemo(
    () => options.find((option) => option.id === value) ?? null,
    [options, value],
  )

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return options
      .filter(
        (option) =>
          !needle ||
          option.label.toLowerCase().includes(needle) ||
          option.hint?.toLowerCase().includes(needle),
      )
      .slice(0, 50)
  }, [options, query])

  function choose(next: string) {
    onChange(next)
    setQuery('')
    setOpen(false)
  }

  return (
    <div ref={box} className="relative">
      <input type="hidden" name={name} value={value} />

      {disabled ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-3 py-2 text-sm text-slate-400">
          {disabledHint ?? emptyLabel}
        </p>
      ) : selected ? (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
            {selected.label}
            {selected.hint && <span className="ml-2 text-xs text-slate-400">{selected.hint}</span>}
          </span>
          <button
            type="button"
            onClick={() => {
              choose('')
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
              id={id}
              type="text"
              className="input pl-9"
              placeholder={placeholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setOpen(false)
                if (event.key === 'Enter' && matches.length > 0) {
                  event.preventDefault()
                  choose(matches[0].id)
                }
              }}
              role="combobox"
              aria-expanded={open}
              aria-controls={`${name}-options`}
            />
          </div>

          {open && (
            <ul
              id={`${name}-options`}
              className="card absolute z-30 mt-1 max-h-64 w-full overflow-y-auto p-1"
            >
              {matches.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    onClick={() => choose(option.id)}
                    className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-slate-50"
                  >
                    <span className="block truncate text-sm text-slate-700">{option.label}</span>
                    {option.hint && (
                      <span className="block truncate text-xs text-slate-400">{option.hint}</span>
                    )}
                  </button>
                </li>
              ))}
              {matches.length === 0 && (
                <li className="px-2.5 py-2 text-sm text-slate-500">Nothing matches.</li>
              )}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
