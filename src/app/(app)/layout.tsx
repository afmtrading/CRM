import Link from 'next/link'

import { requireSession } from '@/lib/tenancy'

import { NavLink } from '@/components/nav-link'

const NAV = [
  { href: '/', label: 'Dashboard', exact: true },
  { href: '/contacts', label: 'Contacts' },
  { href: '/companies', label: 'Companies' },
  { href: '/deals', label: 'Deals' },
  { href: '/activities', label: 'Activities' },
  { href: '/reports/pipeline-value', label: 'Reports' },
]

const ADMIN_NAV = [
  { href: '/settings/pipelines', label: 'Pipelines' },
  { href: '/settings/users', label: 'Users' },
  { href: '/settings/lead-scoring', label: 'Lead scoring' },
  { href: '/settings/assignment', label: 'Assignment' },
  { href: '/settings/fields', label: 'Custom fields' },
  { href: '/settings/tags', label: 'Tags' },
  { href: '/settings/import', label: 'Import' },
  { href: '/settings/duplicates', label: 'Duplicates' },
]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, organization, isAdmin } = await requireSession()

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-4">
          <Link href="/" className="flex items-center gap-2">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-white"
              style={{ backgroundColor: organization.primary_color }}
            >
              {organization.name.slice(0, 1)}
            </span>
            <span className="truncate text-sm font-semibold text-slate-900">{organization.name}</span>
          </Link>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
          {NAV.map((item) => (
            <NavLink key={item.href} href={item.href} exact={item.exact}>
              {item.label}
            </NavLink>
          ))}

          {isAdmin && (
            <>
              <p className="mt-5 mb-1 px-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Settings
              </p>
              {ADMIN_NAV.map((item) => (
                <NavLink key={item.href} href={item.href}>
                  {item.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>

        <div className="border-t border-slate-200 p-3">
          <p className="truncate text-sm font-medium text-slate-800">{user.name || user.email}</p>
          <p className="truncate text-xs text-slate-500">
            {user.role === 'admin' ? 'Administrator' : 'User'}
          </p>
          <form action="/auth/signout" method="post" className="mt-2">
            <button type="submit" className="text-xs text-slate-500 hover:text-slate-800">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <main className="mx-auto max-w-7xl p-6">{children}</main>
      </div>
    </div>
  )
}
