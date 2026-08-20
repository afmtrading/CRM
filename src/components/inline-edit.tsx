'use client'

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'

import type { OptionColor } from '@/lib/database.types'
import { OPTION_COLOR_CLASSES } from '@/lib/field-options'
import { CheckIcon, ChevronDownIcon } from '@/components/icons'
import { updateCell } from '@/app/(app)/inline-actions'

/**
 * Editing a field from the list, without opening the record.
 *
 * A cell holding a chosen value is a button: click it, pick from the list,
 * and it is saved — no record page, no form, no Save. The fields that offer
 * this are the ones with a vocabulary behind them, which is not a shortcut so
 * much as the honest boundary. A select can be validated by looking at what
 * was clicked; a name, an email address or a price cannot, and those still
 * open the record where the form checks them properly.
 *
 * Everything about the row stays server-rendered. Only the cells that can be
 * edited become client components, and each one holds the value it is showing
 * and nothing else.
 */

export interface InlineOption {
  value: string
  label: string
  /** Draws the option as the badge it is in the table. Absent means plain text. */
  color?: OptionColor
  /**
   * Where this value goes, when it is a record of its own rather than a word.
   *
   * A contact's company is both things at once: something to change from the
   * list, and something to click through to. Given a link, the value stays one
   * and only the chevron beside it opens the menu — so gaining an editor does
   * not cost the way out of the row. It rides on the option rather than being
   * passed alongside the cell so that it follows the value: pick a different
   * company and the link points at that one immediately, without waiting for
   * the server to say so.
   */
  href?: string
}

/** How wide the popover is, and how far it is allowed to hang below the fold. */
const MENU_WIDTH = 240
const MENU_MAX_HEIGHT = 288

/*
 * How many options are drawn at once.
 *
 * The company picker offers every company the organization has, which on a
 * grown book is a four-figure list, and a menu that renders all of it is a
 * menu that stutters on the way open. Past this the rest are counted rather
 * than drawn, and the search box above is how you reach them.
 */
const MENU_LIMIT = 50

/** Where the menu goes: under the cell, nudged back on screen if it would not fit. */
function menuPosition(anchor: DOMRect) {
  const left = Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8)
  const below = window.innerHeight - anchor.bottom

  /*
   * Above the cell when there is more room there. A menu that opens downwards
   * from the last row of a long table is a menu you cannot see the bottom of,
   * and the page behind it does not scroll while it is open.
   */
  return below < 200 && anchor.top > below
    ? { left: Math.max(8, left), bottom: window.innerHeight - anchor.top + 4 }
    : { left: Math.max(8, left), top: anchor.bottom + 4 }
}

function Badge({ option }: { option: InlineOption }) {
  return option.color ? (
    <span className={`badge ${OPTION_COLOR_CLASSES[option.color]}`}>{option.label}</span>
  ) : (
    <span className="truncate text-slate-700">{option.label}</span>
  )
}

export function InlineEdit({
  entity,
  id,
  field,
  fieldLabel,
  values,
  options,
  multiple = false,
  clearable = true,
  canEdit,
}: {
  entity: 'contact' | 'company'
  id: string
  /** The column, named as `bulk_update_records` names it. */
  field: string
  /** Said out loud to a screen reader, e.g. "Priority". */
  fieldLabel: string
  values: string[]
  options: InlineOption[]
  multiple?: boolean
  /**
   * Whether the field may be emptied. False for the columns that are not
   * nullable — a contact always has a lifecycle stage, and "none" is `lead`
   * rather than an absence.
   */
  clearable?: boolean
  /** False renders the value and nothing else — no button, no hover. */
  canEdit: boolean
}) {
  /*
   * What the cell is showing, which is not always what the server last said:
   * a click updates this immediately and the write follows. A refused write
   * puts it back, which is why the server's answer is kept rather than
   * discarded once it has been applied.
   */
  const [chosen, setChosen] = useState(values)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [position, setPosition] = useState<React.CSSProperties | null>(null)
  const [saving, startTransition] = useTransition()

  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  /*
   * The whole cell, which is what the menu is lined up under and what counts
   * as "inside" for a click. Usually that is the button itself; where the
   * value is a link the button is only the chevron at the end of the row, and
   * hanging the menu off that would put it in the wrong place.
   */
  const cell = useRef<HTMLSpanElement>(null)

  /*
   * The list re-renders on the server after every save — the row may even have
   * moved to another group — so whatever it says last is the truth.
   * Compared as JSON rather than by identity: a fresh array holding the same
   * values is the same answer, and re-running this on every render would fight
   * the optimistic update it is meant to confirm.
   */
  const settled = JSON.stringify(values)
  useEffect(() => {
    setChosen(JSON.parse(settled) as string[])
  }, [settled])

  // Placed after the browser has measured the trigger, before it paints, so
  // the menu never appears in the top-left corner for a frame first.
  useLayoutEffect(() => {
    const anchor = cell.current ?? trigger.current
    if (!open || !anchor) return
    setPosition(menuPosition(anchor.getBoundingClientRect()))
  }, [open])

  useEffect(() => {
    if (!open) return

    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (menu.current?.contains(target) || cell.current?.contains(target)) return
      setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    /*
     * Scrolling closes it rather than moving it. The menu is positioned
     * against the viewport and the table it belongs to scrolls sideways inside
     * its own panel; following that would mean measuring on every frame for a
     * gesture that means "I am looking at something else now" anyway.
     */
    const scrolled = () => setOpen(false)

    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', scrolled)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', scrolled, true)
      window.removeEventListener('resize', scrolled)
    }
  }, [open])

  const save = (next: string[]) => {
    const previous = chosen
    setChosen(next)
    setError(null)

    startTransition(async () => {
      const result = await updateCell({ entity, id, field, values: next })
      if (result.error) {
        setChosen(previous)
        setError(result.error)
      }
    })
  }

  const choose = (value: string) => {
    if (multiple) {
      save(chosen.includes(value) ? chosen.filter((item) => item !== value) : [...chosen, value])
      return
    }
    setOpen(false)
    // Picking the value it already holds is not a change worth a round trip.
    if (chosen.length === 1 && chosen[0] === value) return
    save([value])
  }

  const known = new Map(options.map((option) => [option.value, option]))
  /*
   * A value the option list no longer has is still shown — an admin can
   * rename or remove an option in Settings and the records holding the old
   * one must not go blank. It draws as a plain chip, and choosing anything
   * replaces it.
   */
  const shown = chosen.map((value) => known.get(value) ?? { value, label: value })

  const display =
    shown.length === 0 ? (
      <span className="text-slate-400">—</span>
    ) : (
      <span className="flex min-w-0 flex-wrap gap-1">
        {shown.map((option) => (
          <Badge key={option.value} option={option} />
        ))}
      </span>
    )

  if (!canEdit) return display

  const matches = search.trim()
    ? options.filter((option) => option.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options
  const drawn = matches.slice(0, MENU_LIMIT)

  /*
   * The value points somewhere, so it stays a link and the chevron beside it
   * becomes the editor. Only for a single value with somewhere to go: a list
   * of links would be a row of separate targets, and an empty cell has nothing
   * to link to, so both of those get the ordinary whole-cell button.
   */
  const single = !multiple && shown.length === 1 ? shown[0] : undefined
  const href = single?.href
  const linked = single && href ? { label: single.label, href } : null

  const chevron = (
    <ChevronDownIcon
      className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-opacity ${
        open ? 'opacity-100' : 'opacity-0 group-hover/cell:opacity-100'
      }`}
    />
  )

  const openMenu = () => {
    setSearch('')
    setOpen((was) => !was)
  }

  // The list sits inside the bulk-edit form. A button with no type submits it,
  // which would apply whatever the bar happens to be showing.
  const buttonProps = {
    ref: trigger,
    type: 'button' as const,
    onClick: openMenu,
    'aria-haspopup': 'listbox' as const,
    'aria-expanded': open,
  }

  return (
    <>
      <span
        ref={cell}
        className={`group/cell -mx-1.5 -my-1 flex w-full min-w-0 items-center gap-1 rounded-lg px-1.5 py-1 transition-colors hover:bg-brand-50 ${
          open ? 'bg-brand-50 ring-1 ring-brand-300' : ''
        } ${saving ? 'opacity-60' : ''}`}
      >
        {linked ? (
          <>
            <Link
              href={linked.href}
              className="min-w-0 flex-1 truncate text-slate-600 hover:text-brand-700 hover:underline"
            >
              {linked.label}
            </Link>
            <button
              {...buttonProps}
              aria-label={`Change ${fieldLabel.toLowerCase()} — currently ${linked.label}`}
              className="-mr-0.5 shrink-0 rounded p-0.5 hover:bg-brand-100"
            >
              {chevron}
            </button>
          </>
        ) : (
          <button
            {...buttonProps}
            aria-label={`${fieldLabel}: ${shown.map((option) => option.label).join(', ') || 'empty'}`}
            className="flex w-full min-w-0 items-center gap-1 text-left"
          >
            {display}
            <span className="ml-auto">{chevron}</span>
          </button>
        )}
      </span>

      {/* Said in the cell rather than in a banner at the top of the page: the
          refusal belongs next to the value that sprang back. */}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      {open &&
        position &&
        createPortal(
          /*
             Portalled to the body, because the table it lives in is inside a
             panel that scrolls — a menu positioned within that panel would be
             clipped by it rather than opening over the page.
           */
          <div
            ref={menu}
            role="listbox"
            aria-label={fieldLabel}
            style={{ ...position, width: MENU_WIDTH, maxHeight: MENU_MAX_HEIGHT }}
            className="fixed z-50 overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
          >
            {options.length > 8 && (
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Find an option"
                aria-label={`Find a ${fieldLabel.toLowerCase()}`}
                /* Sticky: the menu scrolls, and a search box that scrolls away
                   is one somebody has to scroll back up to correct. */
                className="sticky top-0 z-10 mb-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
              />
            )}

            {matches.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-slate-400">Nothing matches</p>
            )}

            {drawn.map((option) => {
              const picked = chosen.includes(option.value)
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  onClick={() => choose(option.value)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <Badge option={option} />
                  </span>
                  {picked && <CheckIcon className="h-4 w-4 shrink-0 text-brand-600" />}
                </button>
              )
            })}

            {matches.length > drawn.length && (
              <p className="px-2 py-2 text-center text-xs text-slate-400">
                {matches.length - drawn.length} more — type to narrow the list
              </p>
            )}

            {/*
              Clearing is its own row rather than a blank option at the top of
              the list, which reads as "not chosen yet" rather than as an
              action. Hidden when there is nothing to clear.
            */}
            {clearable && chosen.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (!multiple) setOpen(false)
                  save([])
                }}
                className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-slate-100 px-2 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-50 hover:text-slate-700"
              >
                Clear {fieldLabel.toLowerCase()}
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
