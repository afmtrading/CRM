import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { BellIcon } from '@/components/icons'

const LINK_CLASS =
  'relative rounded-xl p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900'

/**
 * The bell without its count, shown while the count is in flight.
 *
 * Same markup minus the badge, so the header does not reflow when the real one
 * arrives.
 */
export function NotificationBellFallback() {
  return (
    <Link href="/notifications" aria-label="Notifications" className={LINK_CLASS}>
      <BellIcon className="h-5 w-5" />
    </Link>
  )
}

/**
 * Unread count for the bell.
 *
 * Split out of the layout so it can stream. The query is cheap — a partial
 * index covers exactly it — but it ran after the session resolved and before
 * anything rendered, which put a whole round trip in front of the sidebar and
 * header on every navigation. requireSession is request-cached, so asking for
 * the context again here costs nothing.
 */
export async function NotificationBell() {
  const context = await requireSession()

  const { count } = await scoped(context, 'notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)

  const unread = count ?? 0

  return (
    <Link
      href="/notifications"
      aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
      className={LINK_CLASS}
    >
      <BellIcon className="h-5 w-5" />
      {unread > 0 && (
        <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  )
}
