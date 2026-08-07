import Link from 'next/link'

import { requireSession } from '@/lib/tenancy'
import { initials } from '@/lib/format'

import { NavLink } from '@/components/nav-link'
import {
  ActivityIcon,
  AssignmentIcon,
  BellIcon,
  ChevronDownIcon,
  CompaniesIcon,
  ContactsIcon,
  DashboardIcon,
  DealsIcon,
  DuplicatesIcon,
  FieldsIcon,
  ImportIcon,
  PipelinesIcon,
  ReportsIcon,
  ScoringIcon,
  SearchIcon,
  SignOutIcon,
  TagIcon,
  UsersIcon,
} from '@/components/icons'

/**
 * Icons are stored as rendered elements, not components: NavLink is a client
 * component, and a function prop cannot cross the server/client boundary.
 */
const ICON = 'h-[18px] w-[18px]'

const NAV = [
  { href: '/', label: 'Dashboard', icon: <DashboardIcon className={ICON} />, exact: true },
  { href: '/contacts', label: 'Contacts', icon: <ContactsIcon className={ICON} /> },
  { href: '/companies', label: 'Companies', icon: <CompaniesIcon className={ICON} /> },
  { href: '/deals', label: 'Deals', icon: <DealsIcon className={ICON} /> },
  { href: '/activities', label: 'Activities', icon: <ActivityIcon className={ICON} /> },
  { href: '/reports/pipeline-value', label: 'Reports', icon: <ReportsIcon className={ICON} /> },
]

const ADMIN_NAV = [
  { href: '/settings/pipelines', label: 'Pipelines', icon: <PipelinesIcon className={ICON} /> },
  { href: '/settings/users', label: 'Users', icon: <UsersIcon className={ICON} /> },
  { href: '/settings/lead-scoring', label: 'Lead scoring', icon: <ScoringIcon className={ICON} /> },
  { href: '/settings/assignment', label: 'Assignment', icon: <AssignmentIcon className={ICON} /> },
  { href: '/settings/fields', label: 'Custom fields', icon: <FieldsIcon className={ICON} /> },
  { href: '/settings/tags', label: 'Tags', icon: <TagIcon className={ICON} /> },
  { href: '/settings/import', label: 'Import', icon: <ImportIcon className={ICON} /> },
  { href: '/settings/duplicates', label: 'Duplicates', icon: <DuplicatesIcon className={ICON} /> },
]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, organization, isAdmin } = await requireSession()
  const displayName = user.name || user.email

  return (
    <div className="flex min-h-screen">
      {/* Icon rail on narrow screens, full labels from lg up — one nav, not two. */}
      <aside className="sticky top-0 flex h-screen w-16 shrink-0 flex-col border-r border-slate-200/80 bg-white lg:w-60">
        <div className="px-3 py-5 lg:px-5">
          <Link href="/" className="flex items-center gap-2.5" title={organization.name}>
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white"
              style={{ backgroundColor: organization.primary_color }}
            >
              {organization.name.slice(0, 1)}
            </span>
            <span className="hidden truncate text-sm font-semibold text-slate-900 lg:block">
              {organization.name}
            </span>
          </Link>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-4 lg:px-3">
          {NAV.map((item) => (
            <NavLink key={item.href} href={item.href} icon={item.icon} exact={item.exact}>
              {item.label}
            </NavLink>
          ))}

          {isAdmin && (
            <>
              <p className="mt-6 mb-2 hidden px-3 text-[11px] font-semibold tracking-wider text-slate-400 uppercase lg:block">
                Settings
              </p>
              <hr className="mt-6 mb-2 border-slate-200 lg:hidden" />
              {ADMIN_NAV.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon}>
                  {item.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>

        <div className="border-t border-slate-200/80 p-2 lg:p-3">
          <div className="flex items-center gap-2.5 rounded-xl px-1 py-2 lg:px-2">
            <span className="avatar h-8 w-8 bg-brand-100 text-brand-700" title={displayName}>
              {initials(displayName)}
            </span>
            <div className="hidden min-w-0 flex-1 lg:block">
              <p className="truncate text-sm font-medium text-slate-800">{displayName}</p>
              <p className="truncate text-xs text-slate-500">
                {user.role === 'admin' ? 'Administrator' : 'User'}
              </p>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/85 backdrop-blur">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            {/* Global search lands on Contacts, which is where a name lookup
                almost always means to go. */}
            <form action="/contacts" className="relative max-w-md flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                name="q"
                placeholder="Search anything…"
                aria-label="Search contacts"
                className="input bg-slate-50 pl-9"
              />
            </form>

            <div className="ml-auto flex items-center gap-1.5">
              <Link
                href="/activities"
                aria-label="Activities"
                className="hidden rounded-xl p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 sm:block"
              >
                <BellIcon className="h-5 w-5" />
              </Link>

              {/* <details> keeps the menu server-rendered — no client bundle
                  for something this small. */}
              <details className="group relative">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl py-1.5 pr-2 pl-1.5 transition-colors hover:bg-slate-100">
                  <span className="avatar h-8 w-8 bg-brand-100 text-brand-700">
                    {initials(displayName)}
                  </span>
                  <span className="hidden max-w-32 truncate text-sm font-medium text-slate-700 sm:block">
                    {displayName}
                  </span>
                  <ChevronDownIcon className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" />
                </summary>

                <div className="card absolute right-0 z-30 mt-2 w-56 p-1.5">
                  <div className="border-b border-slate-100 px-2.5 py-2">
                    <p className="truncate text-sm font-medium text-slate-800">{displayName}</p>
                    <p className="truncate text-xs text-slate-500">{user.email}</p>
                  </div>
                  <form action="/auth/signout" method="post">
                    <button
                      type="submit"
                      className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
                    >
                      <SignOutIcon className="h-4 w-4" />
                      Sign out
                    </button>
                  </form>
                </div>
              </details>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  )
}
