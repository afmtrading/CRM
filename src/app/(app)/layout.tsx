import Link from 'next/link'

import { cookies } from 'next/headers'

import { requireSession, scoped } from '@/lib/tenancy'
import { USER_ROLE_LABELS } from '@/lib/field-options'

import { NavGroup } from '@/components/nav-group'
import { Sidebar } from '@/components/sidebar'
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
  MailIcon,
  PipelinesIcon,
  ProductsIcon,
  InvoiceIcon,
  ReportsIcon,
  SalesOrderIcon,
  ScoringIcon,
  StoreIcon,
  SettingsIcon,
  ShieldIcon,
  SearchIcon,
  SendIcon,
  SignOutIcon,
  TagIcon,
  TrashIcon,
  UsersIcon,
  StockIcon,
} from '@/components/icons'

/**
 * Icons are stored as rendered elements, not components: NavLink is a client
 * component, and a function prop cannot cross the server/client boundary.
 */
const ICON = 'h-[18px] w-[18px]'

type NavItem = { href: string; label: string; icon: React.ReactNode; exact?: boolean }

/**
 * The three that belong to nobody.
 *
 * Dashboard is where you land, Activities is what you owe people today, and
 * Reports is what happened. None of them is a kind of record, so none of them
 * sits under a heading — they are the things you open without first deciding
 * what you are working on.
 */
const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: <DashboardIcon className={ICON} />, exact: true },
  { href: '/activities', label: 'Activities', icon: <ActivityIcon className={ICON} /> },
  // The ledger is where Reports starts: it is the only screen that answers
  // "what happened", and the others are slices of it.
  { href: '/reports/deals', label: 'Reports', icon: <ReportsIcon className={ICON} /> },
]

/** Who and what you sell to, and what you sell. The nouns. */
const DATABASE_NAV: NavItem[] = [
  { href: '/contacts', label: 'Contacts', icon: <ContactsIcon className={ICON} /> },
  { href: '/companies', label: 'Companies', icon: <CompaniesIcon className={ICON} /> },
  /*
   * Under Database rather than in Sales: a marketplace is a record type, not a
   * document. It is the same companies as the row above, narrowed to the ones
   * you trade through and asked a different question.
   */
  { href: '/marketplaces', label: 'Marketplaces', icon: <StoreIcon className={ICON} /> },
  { href: '/products', label: 'Products', icon: <ProductsIcon className={ICON} /> },
]

/*
 * Deals, orders and invoices are siblings here, not a chain. An order is not a
 * stage a deal reaches and an invoice does not need an order behind it — the
 * three are separate documents that happen to share a customer. See
 * docs/SALES_ORDERS_INVOICES.md.
 */
const SALES_NAV: NavItem[] = [
  { href: '/deals', label: 'Deals', icon: <DealsIcon className={ICON} /> },
  { href: '/purchase-orders', label: 'Purchase orders', icon: <SalesOrderIcon className={ICON} /> },
  { href: '/invoices', label: 'Invoices', icon: <InvoiceIcon className={ICON} /> },
]

const MARKETING_NAV: NavItem[] = [
  { href: '/lists', label: 'Lists', icon: <MailIcon className={ICON} /> },
  { href: '/campaigns', label: 'Campaigns', icon: <SendIcon className={ICON} /> },
]

const ADMIN_NAV: NavItem[] = [
  { href: '/settings/organization', label: 'Organization', icon: <SettingsIcon className={ICON} /> },
  { href: '/settings/pipelines', label: 'Pipelines', icon: <PipelinesIcon className={ICON} /> },
  { href: '/settings/users', label: 'Users', icon: <UsersIcon className={ICON} /> },
  { href: '/settings/lead-scoring', label: 'Lead scoring', icon: <ScoringIcon className={ICON} /> },
  { href: '/settings/assignment', label: 'Assignment', icon: <AssignmentIcon className={ICON} /> },
  { href: '/settings/fields', label: 'Fields', icon: <FieldsIcon className={ICON} /> },
  { href: '/settings/tags', label: 'Tags', icon: <TagIcon className={ICON} /> },
  { href: '/settings/locations', label: 'Locations', icon: <StockIcon className={ICON} /> },
  { href: '/settings/duplicates', label: 'Duplicates', icon: <DuplicatesIcon className={ICON} /> },
  { href: '/settings/deleted', label: 'Deleted records', icon: <TrashIcon className={ICON} /> },
  { href: '/settings/mailboxes', label: 'Mailboxes', icon: <MailIcon className={ICON} /> },
  { href: '/settings/email', label: 'Email sending', icon: <MailIcon className={ICON} /> },
]

/**
 * Permissions has its own condition rather than sitting in ADMIN_NAV, because
 * the two capabilities come apart on purpose. Someone can hold Manage
 * permissions without Settings — which is the point of separating them — and an
 * administrator can be given Settings without the rulebook.
 */
const PERMISSIONS_NAV: NavItem[] = [
  { href: '/settings/permissions', label: 'Permissions', icon: <ShieldIcon className={ICON} /> },
]

/**
 * Import is in Settings with the rest, but it is not an administrator's alone —
 * a manager who can bulk-edit can also bring records in. So it is kept apart
 * from ADMIN_NAV and added to the group under its own condition, which is how a
 * manager gets a Settings section containing exactly this one row.
 */
const MANAGER_NAV: NavItem[] = [
  { href: '/settings/import', label: 'Import', icon: <ImportIcon className={ICON} /> },
]

/** The groups everybody sees, in order. Settings is built per role below. */
const GROUPS: { label: string; items: NavItem[] }[] = [
  { label: 'Database', items: DATABASE_NAV },
  { label: 'Sales', items: SALES_NAV },
  { label: 'Marketing', items: MARKETING_NAV },
]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const context = await requireSession()
  /*
   * Read here rather than in the browser so the first paint is already the
   * right width. See components/sidebar for why this is a cookie.
   */
  const collapsed = (await cookies()).get('sidebar')?.value === 'collapsed'
  const { user, organization, isAdmin, canBulk } = context
  const displayName = user.name || user.email

  // Empty for a regular user, one row for a manager who can import, the lot for
  // an administrator — and an empty group is not drawn at all.
  const settingsItems = [
    ...(isAdmin ? ADMIN_NAV : []),
    ...(context.canManagePermissions ? PERMISSIONS_NAV : []),
    ...(isAdmin || canBulk ? MANAGER_NAV : []),
  ]

  // Unread count for the bell. Cheap: a partial index covers exactly this.
  const { count: unread } = await scoped(context, 'notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)

  return (
    <div className="flex min-h-screen">
      {/*
        Icon rail on narrow screens, full labels from lg up — one nav, not two.
        Closing it from lg up puts it back on the rail, which is why there is
        only one set of styles to keep true.
      */}
      <Sidebar
        defaultCollapsed={collapsed}
        brand={
          <Link href="/" className="flex min-w-0 items-center gap-2.5" title={organization.name}>
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white"
              style={{ backgroundColor: organization.primary_color }}
            >
              {organization.name.slice(0, 1)}
            </span>
            <span className="sidebar-label hidden truncate text-sm font-semibold text-slate-900 lg:block">
              {organization.name}
            </span>
          </Link>
        }
        footer={
          <div className="border-t border-slate-200/80 p-2 lg:p-3">
            <div className="flex items-center gap-2.5 rounded-xl px-1 py-2 lg:px-2">
              <div className="sidebar-label hidden min-w-0 flex-1 lg:block">
                <p className="truncate text-sm font-medium text-slate-800">{displayName}</p>
                <p className="truncate text-xs text-slate-500">
                  {USER_ROLE_LABELS[user.role] ?? user.role}
                </p>
              </div>
            </div>
          </div>
        }
      >
        <nav className="flex-1 overflow-y-auto px-2 pb-4 lg:px-3">
          <div className="space-y-1">
            {NAV.map((item) => (
              <NavLink key={item.href} href={item.href} icon={item.icon} exact={item.exact}>
                {item.label}
              </NavLink>
            ))}
          </div>

          {GROUPS.map((group) => (
            <NavGroup
              key={group.label}
              label={group.label}
              hrefs={group.items.map((item) => item.href)}
            >
              {group.items.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon}>
                  {item.label}
                </NavLink>
              ))}
            </NavGroup>
          ))}

          {settingsItems.length > 0 && (
            <NavGroup label="Settings" hrefs={settingsItems.map((item) => item.href)}>
              {settingsItems.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon}>
                  {item.label}
                </NavLink>
              ))}
            </NavGroup>
          )}
        </nav>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/85 backdrop-blur print:hidden">
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
                href="/notifications"
                aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
                className="relative rounded-xl p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
              >
                <BellIcon className="h-5 w-5" />
                {(unread ?? 0) > 0 && (
                  <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                    {(unread ?? 0) > 9 ? '9+' : unread}
                  </span>
                )}
              </Link>

              {/* <details> keeps the menu server-rendered — no client bundle
                  for something this small. */}
              <details className="group relative">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl py-1.5 pr-2 pl-1.5 transition-colors hover:bg-slate-100">
                  <span className="max-w-32 truncate text-sm font-medium text-slate-700">
                    {displayName}
                  </span>
                  <ChevronDownIcon className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" />
                </summary>

                <div className="card absolute right-0 z-30 mt-2 w-56 p-1.5">
                  <div className="border-b border-slate-100 px-2.5 py-2">
                    <p className="truncate text-sm font-medium text-slate-800">{displayName}</p>
                    <p className="truncate text-xs text-slate-500">{user.email}</p>
                  </div>
                  <Link
                    href="/settings/mailboxes"
                    className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
                  >
                    <MailIcon className="h-4 w-4" />
                    Mailboxes
                  </Link>
                  <form action="/auth/signout" method="post">
                    <button
                      type="submit"
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
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

        <main className="mx-auto w-full max-w-[1600px] flex-1 p-4 sm:p-6 print:max-w-none print:p-0">{children}</main>
      </div>
    </div>
  )
}
