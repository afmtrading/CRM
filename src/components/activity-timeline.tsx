import { DateTime } from '@/components/date-time'
import { DueDate } from '@/components/due-date'
import type { ActivityRow, ActivityType, RelatedToType, UserRow } from '@/lib/database.types'

import { deleteActivity, logActivity, toggleActivityComplete } from '@/app/(app)/activities/actions'
import { ActionForm, SubmitButton } from '@/components/action-form'

const TYPE_ICON: Record<ActivityType, string> = {
  call: '📞',
  email: '✉️',
  meeting: '📅',
  note: '📝',
  task: '☑️',
}

/** Log-an-activity composer, shared by the contact, company and deal pages. */
export function ActivityComposer({
  relatedToType,
  relatedToId,
  users,
  currentUserId,
}: {
  relatedToType: RelatedToType
  relatedToId: string
  users: UserRow[]
  currentUserId: string
}) {
  return (
    <ActionForm action={logActivity} className="space-y-2">
      <input type="hidden" name="related_to_type" value={relatedToType} />
      <input type="hidden" name="related_to_id" value={relatedToId} />

      <div className="flex flex-wrap gap-2">
        <select name="type" className="input max-w-32" defaultValue="note">
          <option value="note">Note</option>
          <option value="call">Call</option>
          <option value="email">Email</option>
          <option value="meeting">Meeting</option>
          <option value="task">Task</option>
        </select>
        <input name="subject" className="input flex-1" placeholder="Subject" />
        <input
          name="due_date"
          type="datetime-local"
          className="input max-w-56"
          title="Due date (tasks only)"
        />
        <select name="owner_id" className="input max-w-44" defaultValue={currentUserId}>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name || user.email}
            </option>
          ))}
        </select>
      </div>

      <textarea name="body" className="input min-h-20" placeholder="Details…" />

      <SubmitButton className="btn-primary" pendingLabel="Logging…">
        Log activity
      </SubmitButton>
    </ActionForm>
  )
}

export function ActivityTimeline({
  activities,
  users,
  returnTo,
  emptyMessage = 'Nothing logged yet.',
}: {
  activities: ActivityRow[]
  users: UserRow[]
  returnTo: string
  emptyMessage?: string
}) {
  const userNames = new Map(users.map((user) => [user.id, user.name || user.email]))

  if (activities.length === 0) {
    return <p className="py-4 text-sm text-slate-500">{emptyMessage}</p>
  }

  return (
    <ol className="divide-y divide-slate-100">
      {activities.map((activity) => {
        const done = Boolean(activity.completed_at)

        return (
          <li key={activity.id} className="flex gap-3 py-3">
            <span className="text-lg leading-6" aria-hidden>
              {TYPE_ICON[activity.type]}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <p className={`text-sm font-medium ${done ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
                  {activity.subject || activity.type}
                </p>
                {activity.type === 'task' && activity.due_date && !done && (
                  <DueDate value={activity.due_date} prefix="Due " className="text-xs" />
                )}
                {activity.external_source && (
                  <span className="badge bg-slate-100 text-slate-500">
                    synced · {activity.external_source}
                  </span>
                )}
              </div>

              {activity.body && (
                <p className="mt-1 text-sm whitespace-pre-wrap text-slate-600">{activity.body}</p>
              )}

              <p className="mt-1 text-xs text-slate-400">
                {activity.owner_id ? (userNames.get(activity.owner_id) ?? 'Unknown') : 'Unassigned'} ·{' '}
                <DateTime value={activity.occurred_at ?? activity.created_at} />
              </p>
            </div>

            <div className="flex shrink-0 items-start gap-1">
              {activity.type === 'task' && (
                <form action={toggleActivityComplete}>
                  <input type="hidden" name="id" value={activity.id} />
                  <input type="hidden" name="complete" value={done ? 'false' : 'true'} />
                  <input type="hidden" name="return_to" value={returnTo} />
                  <button type="submit" className="text-xs text-slate-400 hover:text-brand-700">
                    {done ? 'Reopen' : 'Complete'}
                  </button>
                </form>
              )}
              <form action={deleteActivity}>
                <input type="hidden" name="id" value={activity.id} />
                <input type="hidden" name="return_to" value={returnTo} />
                <button type="submit" className="text-xs text-slate-300 hover:text-red-600">
                  Delete
                </button>
              </form>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
