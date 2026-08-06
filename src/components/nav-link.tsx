'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function NavLink({
  href,
  children,
  exact = false,
}: {
  href: string
  children: React.ReactNode
  exact?: boolean
}) {
  const pathname = usePathname()
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href}
      className={`block rounded-md px-2 py-1.5 text-sm transition-colors ${
        active
          ? 'bg-brand-50 font-medium text-brand-700'
          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
      }`}
    >
      {children}
    </Link>
  )
}
