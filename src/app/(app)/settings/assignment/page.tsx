import { requireAdmin, scoped } from '@/lib/tenancy'
import type { AssignmentRuleRow, UserRow } from '@/lib/database.types'
import { PageHeader, Section } from '@/components/ui'

import { createAssignmentRule } from '../actions'
import { AssignmentRuleRows } from './rule-rows'

export const metadata = { title: 'Assignment rules · FLO CRM' }

export default async function AssignmentSettingsPage() {
  const context = await requireAdmin()

  const [{ data: rules }, { data: users }] = await Promise.all([
    scoped(context, 'assignment_rules').select('*').order('priority'),
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
  ])

  const ruleList = (rules ?? []) as AssignmentRuleRow[]
  const userList = (users ?? []) as UserRow[]
  const named = userList.map((user) => ({ id: user.id, name: user.name || user.email }))

  return (
    <>
      <PageHeader title="Assignment & routing" />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title="Rules">
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
                <AssignmentRuleRows rules={ruleList} users={named} />
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
