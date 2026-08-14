'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

import { ChevronDownIcon } from '@/components/icons'

/**
 * A collapsible run of sidebar links under a heading.
 *
 * TWO WIDTHS, ONE NAV
 *
 * Below `lg` the sidebar is a 16px icon rail with no labels and no room for a
 * heading — and no hamburger anywhere else to reach the pages with. So the
 * toggle is chrome that only exists from `lg` up, and a collapsed group still
 * renders every one of its links on the rail. That is the whole trick in
 * `lg:hidden`: closed means hidden where the heading is visible, and nothing
 * where it is not. Collapsing a group must never be a way to lose a page.
 *
 * WHAT IT REMEMBERS
 *
 * The choice is kept per group in localStorage, because a sidebar that forgets
 * is a sidebar you have to rearrange on every reload. It is read in an effect
 * rather than during render: the server has no localStorage, and reading it
 * while rendering would hydrate one tree over a different one. The cost is that
 * a group the reader had closed is briefly open on a cold load, which is the
 * cheaper of the two mistakes.
 *
 * The group holding the current page opens regardless. Arriving somewhere and
 * not being able to see where you are is worse than an ignored preference, and
 * a closed group whose contents you are looking at reads as a bug.
 */
export function NavGroup({
  label,
  hrefs,
  children,
}: {
  label: string
  /** Every link inside, so the group can tell whether it holds the open page. */
  hrefs: string[]
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const holdsCurrentPage = hrefs.some(
    (href) => pathname === href || pathname.startsWith(`${href}/`),
  )

  // Open on the server and on first paint: whatever else happens, the reader
  // never loses a link to a preference that has not loaded yet.
  const [open, setOpen] = useState(true)

  useEffect(() => {
    if (holdsCurrentPage) {
      setOpen(true)
      return
    }
    setOpen(window.localStorage.getItem(`nav-group:${label}`) !== 'closed')
  }, [label, holdsCurrentPage])

  function toggle() {
    setOpen((wasOpen) => {
      window.localStorage.setItem(`nav-group:${label}`, wasOpen ? 'closed' : 'open')
      return !wasOpen
    })
  }

  return (
    <div className="pt-4 first:pt-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="hidden w-full items-center gap-1 rounded-lg px-3 py-1 text-xs font-semibold tracking-wider text-slate-900 uppercase transition-colors hover:text-slate-500 lg:flex"
      >
        <ChevronDownIcon
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
        />
        {label}
      </button>

      {/* The rail has no heading, so it gets a rule instead. */}
      <hr className="mb-2 border-slate-200 lg:hidden" />

      <div className={`space-y-1 ${open ? 'mt-1' : 'lg:hidden'}`}>{children}</div>
    </div>
  )
}
