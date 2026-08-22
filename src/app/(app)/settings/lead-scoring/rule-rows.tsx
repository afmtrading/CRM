'use client'

import { useActionState, useEffect, useState } from 'react'

import type { ActionState } from '@/components/action-form'

import { deleteLeadScoreRule, updateLeadScoreRule } from '../actions'

export interface ScoreRule {
  id: string
  field: string
  condition: string
  value: string | null
  points: number
}

export interface RuleChoice {
  value: string
  label: string
}

/**
 * The rules, and a way to correct one.
 *
 * Every rule here is a number somebody tuned — "a filled-in phone number is
 * worth 5, not 10" — and tuning it meant deleting the rule and typing all four
 * of its parts again. That is a lot of retyping to change one digit, and it
 * moved the rule to the bottom of the list on the way.
 *
 * One row opens at a time, following Settings → Tags: a page of open inputs
 * invites somebody to change four rules and save one.
 */
function RuleEditRow({
  rule,
  fields,
  conditions,
  close,
}: {
  rule: ScoreRule
  fields: RuleChoice[]
  conditions: RuleChoice[]
  close: () => void
}) {
  const [state, formAction, pending] = useActionState(updateLeadScoreRule, {} as ActionState)

  // Closes on success rather than on submit, so a refusal has somewhere to land.
  useEffect(() => {
    if (state.ok) close()
  }, [state.ok, close])

  return (
    <tr>
      <td colSpan={5}>
        <form action={formAction} className="flex flex-wrap items-end gap-2 py-1">
          <input type="hidden" name="id" value={rule.id} />

          <div className="min-w-40 flex-1">
            <label className="label" htmlFor={`rule-field-${rule.id}`}>
              When
            </label>
            <select
              id={`rule-field-${rule.id}`}
              name="field"
              defaultValue={rule.field}
              className="input py-1"
            >
              {/*
                The rule's own field even if it no longer has a definition — a
                custom field deleted after the rule was written would otherwise
                be silently swapped for whichever field sorts first.
              */}
              {fields.some((field) => field.value === rule.field) ? null : (
                <option value={rule.field}>{rule.field} (removed)</option>
              )}
              {fields.map((field) => (
                <option key={field.value} value={field.value}>
                  {field.label}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-36">
            <label className="label" htmlFor={`rule-condition-${rule.id}`}>
              Condition
            </label>
            <select
              id={`rule-condition-${rule.id}`}
              name="condition"
              defaultValue={rule.condition}
              className="input py-1"
            >
              {conditions.map((condition) => (
                <option key={condition.value} value={condition.value}>
                  {condition.label}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-32 flex-1">
            <label className="label" htmlFor={`rule-value-${rule.id}`}>
              Value
            </label>
            <input
              id={`rule-value-${rule.id}`}
              name="value"
              defaultValue={rule.value ?? ''}
              placeholder="website"
              className="input py-1"
            />
          </div>

          <div className="w-24">
            <label className="label" htmlFor={`rule-points-${rule.id}`}>
              Points
            </label>
            <input
              id={`rule-points-${rule.id}`}
              name="points"
              type="number"
              defaultValue={rule.points}
              className="input py-1"
            />
          </div>

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

        <p className="pb-1 text-xs text-slate-400">
          Saving recalculates every contact&rsquo;s score, the same as adding a rule does.
        </p>
      </td>
    </tr>
  )
}

export function LeadScoreRuleRows({
  rules,
  fields,
  conditions,
}: {
  rules: ScoreRule[]
  fields: RuleChoice[]
  conditions: RuleChoice[]
}) {
  const [editing, setEditing] = useState<string | null>(null)

  const fieldLabels = new Map(fields.map((field) => [field.value, field.label]))
  const conditionLabels = new Map(conditions.map((condition) => [condition.value, condition.label]))

  return (
    <tbody>
      {rules.map((rule) =>
        editing === rule.id ? (
          <RuleEditRow
            key={rule.id}
            rule={rule}
            fields={fields}
            conditions={conditions}
            close={() => setEditing(null)}
          />
        ) : (
          <tr key={rule.id}>
            <td className="font-medium text-slate-800">
              {fieldLabels.get(rule.field) ?? rule.field}
            </td>
            <td className="text-slate-600">
              {conditionLabels.get(rule.condition) ?? rule.condition}
            </td>
            <td className="text-slate-600">{rule.value ?? '—'}</td>
            <td className="text-right font-medium">
              {rule.points > 0 ? `+${rule.points}` : rule.points}
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
                <form action={deleteLeadScoreRule}>
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
