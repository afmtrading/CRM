'use client'

import { useEffect, useRef, useState } from 'react'

import { ChevronDownIcon } from '@/components/icons'

/**
 * Grouped lists that fold shut.
 *
 * A list grouped by owner and then by priority is a dozen headings and four
 * hundred rows, and somebody looking for one of those groups has to scroll
 * past all of the others to reach it. Both levels close here: level 1 takes
 * its whole panel with it, level 2 takes the rows under its band.
 *
 * The rows are server-rendered and handed in as children, so nothing about the
 * tables moves to the browser — these two components hold one boolean each and
 * decide whether to render what they were given.
 */

/** Where one group's open/shut state is written down. */
function storageKeyFor(scope: string, id: string) {
  return `flo-crm.group:${scope}:${id}`
}

/**
 * Remembers whether a group is open, across reloads and across the server
 * re-render that every filter change causes.
 *
 * Starts open and reads the stored answer in an effect rather than during
 * render: the server has no localStorage, and seeding state from it directly
 * would mean the first client render disagreed with the HTML that arrived.
 * A group somebody closed therefore flickers open for one frame after a hard
 * reload, which is the cheap half of the trade.
 *
 * Storage is per group rather than one list of the closed ones. A key that
 * cannot be read — Safari in private browsing throws rather than returning
 * null — leaves the group open, which is the state that hides nothing.
 */
function useOpen(scope: string, id: string) {
  const [open, setOpen] = useState(true)
  const key = storageKeyFor(scope, id)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key)
      if (stored !== null) setOpen(stored === 'open')
    } catch {
      /* Storage unavailable: leave it open. */
    }
  }, [key])

  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      window.localStorage.setItem(key, next ? 'open' : 'closed')
    } catch {
      /* Same again — the fold still works, it just will not be remembered. */
    }
  }

  return { open, toggle }
}

/**
 * Tells the bulk-edit bar to recount after rows appear or disappear.
 *
 * The selection is plain checkboxes inside one form and the bar counts them by
 * listening for `change`. Folding a group away removes its checkboxes from the
 * DOM, which fires nothing, so the bar would keep offering to apply a change
 * to rows that are no longer in the form. Skips the first run: on mount
 * nothing has moved yet.
 */
function useRecount(open: boolean) {
  const anchor = useRef<HTMLElement | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    anchor.current?.closest('form')?.dispatchEvent(new Event('change', { bubbles: true }))
  }, [open])

  return anchor
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronDownIcon
      className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-150 ${
        open ? '' : '-rotate-90'
      }`}
    />
  )
}

/**
 * Level 1: a heading, whatever summary the page wants beside it, and the panel
 * underneath.
 *
 * `label` absent means the list is not grouped at all, and then there is no
 * heading to press — the children are rendered on their own rather than being
 * wrapped in a fold nobody can open.
 */
export function CollapsibleGroup({
  scope,
  id,
  label,
  summary,
  children,
}: {
  /** Which list this is, so two pages cannot share a remembered state. */
  scope: string
  /** Which group, within that list. The group's own key where it has one. */
  id: string
  label?: string
  /** Shown at the right of the heading — a count, or a row of totals. */
  summary?: React.ReactNode
  children: React.ReactNode
}) {
  const { open, toggle } = useOpen(scope, id)
  const anchor = useRecount(open)

  if (!label) return <section>{children}</section>

  return (
    <section ref={anchor as React.RefObject<HTMLElement>}>
      <div className="group-header flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {/*
          The heading is the control. A separate chevron button beside it would
          give the eye two targets for one action, and the heading is the thing
          people already aim at.
        */}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 rounded-lg text-left hover:opacity-80"
        >
          <Chevron open={open} />
          <h2 className="truncate">{label}</h2>
        </button>
        {summary}
      </div>
      {open && children}
    </section>
  )
}

/**
 * Level 2: the band inside the table, and the rows under it.
 *
 * A row of the same table rather than a nested one, because the columns have
 * to keep lining up — a table per sub-group would let each choose its own
 * widths, and a list you cannot read down a column is not a list.
 *
 * The band's fill, the rule above it and the spacing all live in globals.css,
 * where they can out-specify the `.table td` defaults they have to beat.
 */
export function CollapsibleSubGroup({
  scope,
  id,
  label,
  count,
  columns,
  children,
}: {
  scope: string
  id: string
  label: string
  count: number
  /** How many columns to span, so the band reaches across the table. */
  columns: number
  children: React.ReactNode
}) {
  const { open, toggle } = useOpen(scope, id)
  const anchor = useRecount(open)

  return (
    <>
      <tr className="subgroup" ref={anchor as React.RefObject<HTMLTableRowElement>}>
        <td colSpan={columns}>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="flex items-center gap-2 text-left hover:opacity-80"
          >
            <Chevron open={open} />
            <span className="text-sm font-bold tracking-wide text-brand-700 uppercase">
              {label}
            </span>
            <span className="text-sm text-slate-400">{count}</span>
          </button>
        </td>
      </tr>
      {open && children}
    </>
  )
}
