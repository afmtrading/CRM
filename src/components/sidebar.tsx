'use client'

import { useState } from 'react'

/**
 * The left sidebar, open or shut.
 *
 * THREE STATES, NOT TWO
 *
 * Below `lg` there is no choice: the sidebar is a 4rem icon rail, because
 * nothing else fits and there is no hamburger anywhere to reach the pages with.
 * From `lg` up it is the reader's call, and the toggle only exists there —
 * offering a control that cannot change anything is worse than not offering it.
 *
 * Collapsed is the same rail, so there is one nav and one set of styles rather
 * than a second narrow sidebar that has to be kept in step with the first.
 *
 * NO FLASH
 *
 * The choice is a cookie, not localStorage, and it is read on the server — see
 * the layout. localStorage would mean rendering expanded, hydrating, and
 * snapping shut, which is a visible jump on every single page load for anybody
 * who prefers it closed. A cookie is on the request, so the first byte of HTML
 * is already right.
 *
 * The cookie is written from here rather than through a server action: it
 * decides how wide a box is, nothing more, and a round trip to store it would
 * make the panel lag behind the click that closed it.
 */
export function Sidebar({
  defaultCollapsed,
  brand,
  footer,
  children,
}: {
  defaultCollapsed: boolean
  /** The logo and organization name. */
  brand: React.ReactNode
  footer: React.ReactNode
  children: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  function toggle() {
    const next = !collapsed
    setCollapsed(next)
    // A year, path-wide, and Lax: it is a display preference, so it should
    // survive a browser restart and it has no business travelling cross-site.
    document.cookie = `sidebar=${next ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`
  }

  return (
    <aside
      /*
       * The width is decided here because this component knows the answer.
       * Everything *inside* keys off data-sidebar instead — see the rule in
       * globals.css — because a label three components down cannot be handed a
       * prop without threading state through markup that has no other reason
       * to care.
       */
      data-sidebar={collapsed ? 'collapsed' : 'expanded'}
      className={`sticky top-0 flex h-screen w-16 shrink-0 flex-col border-r border-slate-200/80 bg-white print:hidden ${
        collapsed ? '' : 'lg:w-60'
      }`}
    >
      <div className="px-3 py-5 lg:px-5">
        <div
          className={
            collapsed ? 'flex flex-col items-center gap-3' : 'flex items-center gap-2.5'
          }
        >
          {brand}

          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Open the sidebar' : 'Close the sidebar'}
            title={collapsed ? 'Open the sidebar' : 'Close the sidebar'}
            className={`hidden shrink-0 items-center justify-center rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 lg:flex ${
              collapsed ? '' : 'ml-auto'
            }`}
          >
            <ChevronsIcon pointing={collapsed ? 'right' : 'left'} />
          </button>
        </div>
      </div>

      {children}

      {footer}
    </aside>
  )
}

function ChevronsIcon({ pointing }: { pointing: 'left' | 'right' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      {pointing === 'left' ? (
        <>
          <path d="M11 17 6 12l5-5" />
          <path d="M18 17l-5-5 5-5" />
        </>
      ) : (
        <>
          <path d="m13 7 5 5-5 5" />
          <path d="m6 7 5 5-5 5" />
        </>
      )}
    </svg>
  )
}
