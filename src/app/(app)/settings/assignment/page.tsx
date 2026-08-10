import { requireAdmin, scoped } from '@/lib/tenancy'
import type { AssignmentRuleRow, UserRow } from '@/lib/database.types'
import { PageHeader, Section } from '@/components/ui'

import { createAssignmentRule, deleteAssignmentRule } from '../actions'

export const metadata = { title: 'Assignment rules · FLO CRM' }

const STRATEGY_LABELS: Record<string, string> = {
  round_robin: 'Round-robin across active users',
  by_source: 'By contact source',
  fixed_user: 'Always this user',
}

export default async function AssignmentSettingsPage() {
  const context = await requireAdmin()

  const [{ data: rules }, { data: users }] = await Promise.all([
    scoped(context, 'assignment_rules').select('*').order('priority'),
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
  ])

  const ruleList = (rules ?? []) as AssignmentRuleRow[]
  const userList = (users ?? []) as UserRow[]
  const userNames = new Map(userList.map((user) => [user.id, user.name || user.email]))

  return (
    <>
      <PageHeader
        title="Assignment & routing"
        description="Applied in priority order when a new contact arrives without an explicit owner — from the UI, an import, or the API."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title={`${ruleList.length} rule${ruleList.length === 1 ? '' : 's'}`}>
            {ruleList.length === 0 ? (
              <p className="text-sm text-slate-500">
                No routing rules. New contacts are assigned to whoever created them.
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-20">Priority</th>
                    <th>Name</th>
                    <th>Strategy</th>
                    <th>Target</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ruleList.map((rule) => (
                    <tr key={rule.id}>
                      <td className="text-slate-500">{rule.priority}</td>
                      <td className="font-medium text-slate-800">{rule.name}</td>
                      <td className="text-slate-600">{STRATEGY_LABELS[rule.strategy]}</td>
                      <td className="text-slate-600">
                        {rule.strategy === 'by_source' && (
                          <>
                            source = <code className="rounded bg-slate-100 px-1">{rule.source_match}</code>{' '}
                            → {rule.fixed_user_id ? (userNames.get(rule.fixed_user_id) ?? '—') : '—'}
                          </>
                        )}
                        {rule.strategy === 'fixed_user' &&
                          (rule.fixed_user_id ? (userNames.get(rule.fixed_user_id) ?? '—') : '—')}
                        {rule.strategy === 'round_robin' &&
                          (rule.last_assigned_id
                            ? `last: ${userNames.get(rule.last_assigned_id) ?? '—'}`
                            : 'not started')}
                      </td>
                      <td className="text-right">
                        <form action={deleteAssignmentRule}>
                          <input type="hidden" name="id" value={rule.id} />
                          <button type="submit" className="text-xs text-slate-400 hover:text-red-600">
                            Delete
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>

        <Section title="Add a rule">
          <form action={createAssignmentRule} className="space-y-3">
            <div>
              <label className="label" htmlFor="rule-name">
                Name
              </label>
              <input id="rule-name" name="name" required className="input" placeholder="Website leads" />
            </div>

            <div>
              <label className="label" htmlFor="rule-strategy">
                Strategy
              </label>
              <select id="rule-strategy" name="strategy" className="input" defaultValue="round_robin">
                <option value="round_robin">Round-robin</option>
                <option value="by_source">By source</option>
                <option value="fixed_user">Fixed user</option>
              </select>
            </div>

            <div>
              <label className="label" htmlFor="rule-source">
                Source to match
              </label>
              <input id="rule-source" name="source_match" className="input" placeholder="website" />
              <p className="mt-1 text-xs text-slate-400">Only used by the “by source” strategy.</p>
            </div>

            <div>
              <label className="label" htmlFor="rule-user">
                Assign to
              </label>
              <select id="rule-user" name="fixed_user_id" className="input" defaultValue="">
                <option value="">—</option>
                {userList.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name || user.email}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="rule-priority">
                Priority
              </label>
              <input id="rule-priority" name="priority" type="number" defaultValue={0} className="input" />
              <p className="mt-1 text-xs text-slate-400">Lower numbers are evaluated first.</p>
            </div>

            <button type="submit" className="btn-primary w-full">
              Add rule
            </button>
          </form>
        </Section>
      </div>
    </>
  )
}
