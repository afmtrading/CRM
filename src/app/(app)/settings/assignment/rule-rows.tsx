'use client'

import { useActionState, useEffect, useState } from 'react'

import type { ActionState } from '@/components/action-form'

import { deleteAssignmentRule, updateAssignmentRule } from '../actions'

export interface RoutingRule {
  id: string
  name: string
  strategy: string
  source_match: string | null
  fixed_user_id: string | null
  last_assigned_id: string | null
  priority: number
}

export interface RuleUser {
  id: string
  name: string
}

const STRATEGY_LABELS: Record<string, string> = {
  round_robin: 'Round-robin across active users',
  by_source: 'By contact source',
  fixed_user: 'Always this user',
}

/**
 * A routing rule being edited.
 *
 * Rules are read lowest priority number first, so the order they fire in is a
 * number on the row — and until now the only way to change that number was to
 * delete the rule and write it again, which also reset the round-robin's memory
 * of who it had last assigned to. Editing keeps the row, and keeps its place in
 * the rotation.
 */
function RuleEditRow({
  rule,
  users,
  close,
}: {
  rule: RoutingRule
  users: RuleUser[]
  close: () => void
}) {
  const [state, formAction, pending] = useActionState(updateAssignmentRule, {} as ActionState)
  const [strategy, setStrategy] = useState(rule.strategy)

  useEffect(() => {
    if (state.ok) close()
  }, [state.ok, close])

  return (
    <tr>
      <td colSpan={5}>
        <form action={formAction} className="flex flex-wrap items-end gap-2 py-1">
          <input type="hidden" name="id" value={rule.id} />

          <div className="w-20">
            <label className="label" htmlFor={`rule-priority-${rule.id}`}>
              Priority
            </label>
            <input
              id={`rule-priority-${rule.id}`}
              name="priority"
              type="number"
              defaultValue={rule.priority}
              className="input py-1"
            />
          </div>

          <div className="min-w-40 flex-1">
            <label className="label" htmlFor={`rule-name-${rule.id}`}>
              Name
            </label>
            <input
              id={`rule-name-${rule.id}`}
              name="name"
              required
              defaultValue={rule.name}
              className="input py-1"
            />
          </div>

          <div className="min-w-36">
            <label className="label" htmlFor={`rule-strategy-${rule.id}`}>
              Strategy
            </label>
            <select
              id={`rule-strategy-${rule.id}`}
              name="strategy"
              value={strategy}
              onChange={(event) => setStrategy(event.target.value)}
              className="input py-1"
            >
              <option value="round_robin">Round-robin</option>
              <option value="by_source">By source</option>
              <option value="fixed_user">Fixed user</option>
            </select>
          </div>

          {/*
            The two fields that only some strategies read are hidden by the one
            that is chosen, rather than sitting there greyed out: a rule showing
            "Assign to: Dana" under round-robin is a claim about where leads go,
            and it is not true.
          */}
          {strategy === 'by_source' && (
            <div className="min-w-32 flex-1">
              <label className="label" htmlFor={`rule-source-${rule.id}`}>
                Source to match
              </label>
              <input
                id={`rule-source-${rule.id}`}
                name="source_match"
                defaultValue={rule.source_match ?? ''}
                placeholder="website"
                className="input py-1"
              />
            </div>
          )}

          {strategy !== 'round_robin' && (
            <div className="min-w-40">
              <label className="label" htmlFor={`rule-user-${rule.id}`}>
                Assign to
              </label>
              <select
                id={`rule-user-${rule.id}`}
                name="fixed_user_id"
                defaultValue={rule.fixed_user_id ?? ''}
                className="input py-1"
              >
                <option value="">—</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button type="submit" className="btn-primary px-3 py-1.5 text-xs" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={close}>
            Cancel
          </button>
        </form>

        {state.error && (
          <p role="status" className="pb-1 text-xs text-red-700">
            {state.error}
          </p>
        )}
      </td>
    </tr>
  )
}

export function AssignmentRuleRows({ rules, users }: { rules: RoutingRule[]; users: RuleUser[] }) {
  const [editing, setEditing] = useState<string | null>(null)
  const userNames = new Map(users.map((user) => [user.id, user.name]))

  return (
    <tbody>
      {rules.map((rule) =>
        editing === rule.id ? (
          <RuleEditRow
            key={rule.id}
            rule={rule}
            users={users}
            close={() => setEditing(null)}
          />
        ) : (
          <tr key={rule.id}>
            <td className="text-slate-500">{rule.priority}</td>
            <td className="font-medium text-slate-800">{rule.name}</td>
            <td className="text-slate-600">{STRATEGY_LABELS[rule.strategy] ?? rule.strategy}</td>
            <td className="text-slate-600">
              {rule.strategy === 'by_source' && (
                <>
                  source = <code className="rounded bg-slate-100 px-1">{rule.source_match}</code> →{' '}
                  {rule.fixed_user_id ? (userNames.get(rule.fixed_user_id) ?? '—') : '—'}
                </>
              )}
              {rule.strategy === 'fixed_user' &&
                (rule.fixed_user_id ? (userNames.get(rule.fixed_user_id) ?? '—') : '—')}
              {rule.strategy === 'round_robin' &&
                (rule.last_assigned_id
                  ? `last: ${userNames.get(rule.last_assigned_id) ?? '—'}`
                  : 'not started')}
            </td>
            <td>
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setEditing(rule.id)}
                  className="text-xs text-slate-500 hover:text-brand-700"
                >
                  Edit
                </button>
                <form action={deleteAssignmentRule}>
                  <input type="hidden" name="id" value={rule.id} />
                  <button type="submit" className="text-xs text-slate-400 hover:text-red-600">
                    Delete
                  </button>
                </form>
              </div>
            </td>
          </tr>
        ),
      )}
    </tbody>
  )
}
