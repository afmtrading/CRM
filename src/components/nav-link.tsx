'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function NavLink({
  href,
  children,
  icon,
  exact = false,
}: {
  href: string
  children: React.ReactNode
  /**
   * A rendered element, not a component. This is a client component, so a
   * function prop would cross the RSC boundary and fail to serialize at
   * runtime — which typecheck and build both let through. The icon inherits
   * its colour from the wrapper below via `currentColor`.
   */
  icon?: React.ReactNode
  exact?: boolean
}) {
  const pathname = usePathname()
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href}
      title={typeof children === 'string' ? children : undefined}
      aria-current={active ? 'page' : undefined}
      /*
        The page you are on, in the same blue a table's column header row is
        filled with. One colour for "this is the thing" across the app: the
        sidebar says which section, the header row says which columns, and a
        reader learns the signal once rather than twice.
      */
      className={`relative flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm transition-colors lg:px-3 ${
        active
          ? 'bg-brand-500 font-medium text-white'
          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
      }`}
    >
      {/* Accent bar reinforces the active row without relying on fill alone.
          A step darker than the fill it sits on, which is what keeps it a bar
          rather than a smudge now that the fill is solid. */}
      {active && (
        <span className="absolute top-1/2 left-0 h-5 w-1 -translate-y-1/2 rounded-r-full bg-brand-700" />
      )}
      {icon && (
        <span className={`flex shrink-0 ${active ? 'text-white' : 'text-slate-400'}`}>{icon}</span>
      )}
      <span className="sidebar-label hidden truncate lg:block">{children}</span>
    </Link>
  )
}
