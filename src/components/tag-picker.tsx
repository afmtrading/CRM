'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'

import { createTagNamed } from '@/app/(app)/settings/actions'

export interface PickableTag {
  id: string
  name: string
  color: string
}

/**
 * Choosing tags: search, pick, and make a new one without leaving.
 *
 * This replaced a checkbox per tag. That is fine for six and unusable for
 * sixty — every tag on screen at once, no way to search, and defining a new
 * one meant going to Settings, adding it, coming back and finding your place
 * again.
 *
 * The posted shape is unchanged: one hidden `tag_ids` input per selection. The
 * record pages post that on its own and the create/edit forms post it beside
 * everything else, and neither had to learn anything new.
 */
export function TagPicker({
  tags,
  selected,
  name = 'tag_ids',
  canManage = false,
  canCreate = true,
}: {
  tags: PickableTag[]
  selected: Set<string> | string[]
  name?: string
  /** Whether to offer the link to Settings when there are no tags at all. */
  canManage?: boolean
  /** A read-only viewer can still see the chips, but not add to them. */
  canCreate?: boolean
}) {
  const initial = useMemo(
    () => (selected instanceof Set ? [...selected] : selected),
    [selected],
  )

  /*
   * The known tags are held in state rather than read from the prop, because
   * one made here has to join the list without a round trip to the server —
   * the form it sits in has not been submitted yet, so nothing is going to
   * re-render it from fresh data.
   */
  const [known, setKnown] = useState<PickableTag[]>(tags)
  const [chosen, setChosen] = useState<string[]>(initial)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const box = useRef<HTMLDivElement>(null)

  // Clicking anywhere else closes the list. Escape does too, from the input.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const byId = useMemo(() => new Map(known.map((tag) => [tag.id, tag])), [known])
  const trimmed = query.trim()

  const matches = useMemo(() => {
    const needle = trimmed.toLowerCase()
    return known
      .filter((tag) => !chosen.includes(tag.id))
      .filter((tag) => !needle || tag.name.toLowerCase().includes(needle))
      .slice(0, 50)
  }, [known, chosen, trimmed])

  /*
   * Only when nothing already has that name. Offering "Create Orthotics" under
   * a list containing Orthotics is how a list ends up with two of them, and
   * case is not a difference anybody means.
   */
  const exists = known.some((tag) => tag.name.toLowerCase() === trimmed.toLowerCase())
  const offerCreate = canCreate && trimmed.length > 0 && !exists

  function add(id: string) {
    setChosen((current) => (current.includes(id) ? current : [...current, id]))
    setQuery('')
    setError(null)
  }

  function remove(id: string) {
    setChosen((current) => current.filter((value) => value !== id))
  }

  async function create() {
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const tag = await createTagNamed(trimmed)
      setKnown((current) => (current.some((one) => one.id === tag.id) ? current : [...current, tag]))
      add(tag.id)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not add that tag')
    } finally {
      setBusy(false)
    }
  }

  if (known.length === 0 && !canCreate) {
    return (
      <p className="text-xs text-slate-500">
        No tags defined yet.{' '}
        {canManage && (
          <Link href="/settings/tags" className="text-brand-700 hover:underline">
            Create some
          </Link>
        )}
      </p>
    )
  }

  return (
    <div ref={box} className="relative">
      {/* What the form posts. The visible control is not a form field. */}
      {chosen.map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}

      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white p-2 focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-500/20">
        {chosen.map((id) => {
          const tag = byId.get(id)
          if (!tag) return null
          return (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ backgroundColor: `${tag.color}1f`, color: tag.color }}
            >
              {tag.name}
              {canCreate && (
                <button
                  type="button"
                  onClick={() => remove(id)}
                  aria-label={`Remove ${tag.name}`}
                  className="opacity-60 hover:opacity-100"
                >
                  ×
                </button>
              )}
            </span>
          )
        })}

        {canCreate && (
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false)
                return
              }
              // Enter takes the obvious action rather than submitting the form
              // around it, which on a record page would save half a thought.
              if (event.key === 'Enter') {
                event.preventDefault()
                if (matches.length > 0) add(matches[0].id)
                else if (offerCreate) void create()
                return
              }
              // Backspace on an empty box takes the last chip off, which is
              // what every other control of this shape does.
              if (event.key === 'Backspace' && !query && chosen.length > 0) {
                remove(chosen[chosen.length - 1])
              }
            }}
            placeholder={chosen.length === 0 ? 'Search or add a tag…' : 'Add another…'}
            aria-label="Search or add a tag"
            className="min-w-32 flex-1 border-0 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-slate-400"
          />
        )}
      </div>

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      {open && canCreate && (matches.length > 0 || offerCreate) && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {matches.map((tag) => (
            <li key={tag.id}>
              <button
                type="button"
                onClick={() => add(tag.id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50"
              >
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                  aria-hidden
                />
                <span className="truncate">{tag.name}</span>
              </button>
            </li>
          ))}

          {offerCreate && (
            <li className={matches.length > 0 ? 'mt-1 border-t border-slate-100 pt-1' : undefined}>
              <button
                type="button"
                onClick={() => void create()}
                disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50"
              >
                {busy ? 'Adding…' : <>Create &ldquo;{trimmed}&rdquo;</>}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
