import Link from 'next/link'
import { requireSession, scoped } from '@/lib/tenancy'
import { DateTime } from '@/components/date-time'
import type { NotificationRow } from '@/lib/database.types'
import { EmptyState, PageHeader, Section } from '@/components/ui'
import { AlertIcon, BellIcon } from '@/components/icons'
import { markAllNotificationsRead, markNotificationRead } from './actions'
export const metadata = { title: 'Notifications · FLO CRM' }
export default async function NotificationsPage() {
  const context = await requireSession()
  const { data } = await scoped(context, 'notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)
  const notifications = (data ?? []) as NotificationRow[]
  const unread = notifications.filter((notification) => notification.read_at === null)
  return (
    <>
      <PageHeader
        title="Notifications"
        description={
          unread.length > 0
            ? `${unread.length} unread`
            : 'Everything here has been read.'
        }
        actions={
          unread.length > 0 ? (
            <form action={markAllNotificationsRead}>
              <button type="submit" className="btn-secondary">
                Mark all read
              </button>
            </form>
          ) : undefined
        }
      />
      {notifications.length === 0 ? (
        <EmptyState
          title="Nothing to report"
          description="Deleted records and other things worth knowing about will appear here."
        />
      ) : (
        <Section title="Recent">
          <ul className="divide-y divide-slate-100">
            {notifications.map((notification) => {
              const isUnread = notification.read_at === null
              return (
                <li key={notification.id} className="flex items-start gap-3 py-3 first:pt-0">
                  <span
                    className={`icon-chip mt-0.5 h-9 w-9 ${
                      notification.kind.endsWith('_deleted')
                        ? 'bg-red-100 text-red-600'
                        : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {notification.kind.endsWith('_deleted') ? (
                      <AlertIcon className="h-4 w-4" />
                    ) : (
                      <BellIcon className="h-4 w-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-sm ${
                        isUnread ? 'font-semibold text-slate-900' : 'text-slate-700'
                      }`}
                    >
                      {notification.title}
                    </p>
                    {notification.body && (
                      <p className="mt-0.5 text-sm text-slate-500">{notification.body}</p>
                    )}
                    <p className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                      <span><DateTime value={notification.created_at} /></span>
                      {notification.link && (
                        <Link href={notification.link} className="text-brand-700 hover:underline">
                          Open
                        </Link>
                      )}
                    </p>
                  </div>
                  {isUnread && (
                    <form action={markNotificationRead} className="shrink-0">
                      <input type="hidden" name="id" value={notification.id} />
                      <button
                        type="submit"
                        className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      >
                        Mark read
                      </button>
                    </form>
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
      )}
    </>
  )
}
