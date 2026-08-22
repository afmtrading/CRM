import { requireAdmin, scoped } from '@/lib/tenancy'
import type { CustomFieldDefinitionRow, LeadScoreRuleRow } from '@/lib/database.types'
import { PageHeader, Section } from '@/components/ui'

import { createLeadScoreRule, recalculateScores } from '../actions'
import { LeadScoreRuleRows } from './rule-rows'

export const metadata = { title: 'Lead scoring · FLO CRM' }

const CONDITIONS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'is_filled', label: 'is filled in' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
]

const BASE_FIELDS = [
  { key: 'source', label: 'Source' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'lifecycle_stage', label: 'Lifecycle stage' },
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
]

export default async function LeadScoringPage() {
  const context = await requireAdmin()

  const [{ data: rules }, { data: customFields }, { count: contactCount }] = await Promise.all([
    scoped(context, 'lead_score_rules').select('*').order('created_at'),
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'contact'),
    scoped(context, 'contacts').select('id', { count: 'exact', head: true }),
  ])

  const ruleList = (rules ?? []) as LeadScoreRuleRow[]
  const fields = [
    ...BASE_FIELDS,
    ...((customFields ?? []) as CustomFieldDefinitionRow[]).map((definition) => ({
      key: `custom_fields.${definition.key}`,
      label: `${definition.label} (custom)`,
    })),
  ]

  const choices = fields.map((field) => ({ value: field.key, label: field.label }))

  return (
    <>
      <PageHeader
        title="Lead scoring"
        actions={
          <form action={recalculateScores}>
            <button type="submit" className="btn-secondary">
              Recalculate all scores
            </button>
          </form>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title="Rules">
            {ruleList.length === 0 ? (
              <p className="text-sm text-slate-500">
                No rules yet. Every contact scores 0 until you add one.
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Condition</th>
                    <th>Value</th>
                    <th className="text-right">Points</th>
                    <th />
                  </tr>
                </thead>
                <LeadScoreRuleRows rules={ruleList} fields={choices} conditions={CONDITIONS} />
              </table>
            )}
            <p className="mt-3 text-xs text-slate-400">
              Applies to all {contactCount ?? 0} contacts in {context.organization.name}.
            </p>
          </Section>
        </div>

        <Section title="Add a rule">
          <form action={createLeadScoreRule} className="space-y-3">
            <div>
              <label className="label" htmlFor="rule-field">
                Field
              </label>
              <select id="rule-field" name="field" className="input">
                {fields.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="rule-condition">
                Condition
              </label>
              <select id="rule-condition" name="condition" className="input">
                {CONDITIONS.map((condition) => (
                  <option key={condition.value} value={condition.value}>
                    {condition.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="rule-value">
                Value
              </label>
              <input
                id="rule-value"
                name="value"
                className="input"
                placeholder="website"
              />
              <p className="mt-1 text-xs text-slate-400">Leave blank for “is filled in” / “is empty”.</p>
            </div>

            <div>
              <label className="label" htmlFor="rule-points">
                Points
              </label>
              <input id="rule-points" name="points" type="number" defaultValue={10} className="input" />
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
