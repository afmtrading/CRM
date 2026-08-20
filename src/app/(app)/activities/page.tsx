import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { DateTime } from '@/components/date-time'
import { DueDate } from '@/components/due-date'
import type { ActivityRow, UserRow } from '@/lib/database.types'
import { EmptyState, PageHeader } from '@/components/ui'

import { toggleActivityComplete } from './actions'

export const metadata = { title: 'Activities · FLO CRM' }

const TABS = [
  { key: 'mine', label: 'My open tasks' },
  { key: 'all-tasks', label: 'All open tasks' },
  { key: 'timeline', label: 'Everything' },
] as const

type Tab = (typeof TABS)[number]['key']

/** Where an activity's subject links back to. */
function relatedHref(activity: ActivityRow) {
  switch (activity.related_to_type) {
    case 'contact':
      return `/contacts/${activity.related_to_id}`
    case 'company':
      return `/companies/${activity.related_to_id}`
    default:
      return `/deals/${activity.related_to_id}`
  }
}

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const params = await searchParams
  const context = await requireSession()
  const tab: Tab = TABS.some((t) => t.key === params.tab) ? (params.tab as Tab) : 'mine'

  let query = scoped(context, 'activities').select('*')

  if (tab === 'timeline') {
    query = query.order('occurred_at', { ascending: false })
  } else {
    query = query
      .eq('type', 'task')
      .is('completed_at', null)
      .order('due_date', { ascending: true, nullsFirst: false })
    if (tab === 'mine') query = query.eq('owner_id', context.user.id)
  }

  const [{ data: activities }, { data: users }] = await Promise.all([
    query.limit(200),
    scoped(context, 'users').select('*').order('name'),
  ])

  const rows = (activities ?? []) as ActivityRow[]
  const userNames = new Map(((users ?? []) as UserRow[]).map((user) => [user.id, user.name || user.email]))

  return (
    <>
      <PageHeader title="Activities" />

      <div className="mb-4 flex gap-2">
        {TABS.map((item) => (
          <Link
            key={item.key}
            href={`/activities?tab=${item.key}`}
            className={`rounded-full px-3 py-1 text-sm ${
              tab === item.key
                ? 'bg-brand-700 text-white'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={tab === 'timeline' ? 'Nothing logged yet' : 'No open tasks'}
          description="Log activities from any contact, company or deal page."
        />
      ) : (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Subject</th>
                <th>Related to</th>
                <th>Owner</th>
                <th>{tab === 'timeline' ? 'When' : 'Due'}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((activity) => {
                const done = Boolean(activity.completed_at)

                return (
                  <tr key={activity.id} className="hover:bg-slate-50">
                    <td className="capitalize text-slate-600">{activity.type}</td>
                    <td className={done ? 'text-slate-400 line-through' : 'font-medium text-slate-800'}>
                      {activity.subject || '—'}
                    </td>
                    <td>
                      <Link href={relatedHref(activity)} className="text-brand-700 hover:underline">
                        {activity.related_to_type}
                      </Link>
                    </td>
                    <td className="text-slate-600">
                      {activity.owner_id ? (userNames.get(activity.owner_id) ?? '—') : '—'}
                    </td>
                    <td className="text-slate-500">
                      {tab === 'timeline' ? (
                        <DateTime value={activity.occurred_at ?? activity.created_at} />
                      ) : (
                        <DueDate value={activity.due_date} />
                      )}
                    </td>
                    <td className="text-right">
                      {activity.type === 'task' && (
                        <form action={toggleActivityComplete}>
                          <input type="hidden" name="id" value={activity.id} />
                          <input type="hidden" name="complete" value={done ? 'false' : 'true'} />
                          <input type="hidden" name="return_to" value="/activities" />
                          <button type="submit" className="text-xs text-slate-500 hover:text-brand-700">
                            {done ? 'Reopen' : 'Complete'}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
