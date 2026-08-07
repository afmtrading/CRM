import { requireAdmin, scoped } from '@/lib/tenancy'
import type { CustomFieldDefinitionRow } from '@/lib/database.types'
import { CONTACT_CARDS, CONTACT_CARD_LABELS } from '@/lib/field-options'
import { PageHeader, Section } from '@/components/ui'

import { createCustomField, deleteCustomField } from '../actions'

export const metadata = { title: 'Custom fields · FLO CRM' }

export default async function CustomFieldsPage() {
  const context = await requireAdmin()

  const { data: fields } = await scoped(context, 'custom_field_definitions')
    .select('*')
    .order('entity_type')
    .order('order')

  const fieldList = (fields ?? []) as CustomFieldDefinitionRow[]

  return (
    <>
      <PageHeader
        title="Custom fields"
        description="Organization-defined fields on contacts and companies. They are stored as JSON on the record and are filterable, groupable and scoreable like any built-in field."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title={`${fieldList.length} field${fieldList.length === 1 ? '' : 's'}`}>
            {fieldList.length === 0 ? (
              <p className="text-sm text-slate-500">No custom fields defined yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Record type</th>
                    <th>Label</th>
                    <th>Key</th>
                    <th>Type</th>
                    <th>Card</th>
                    <th>Options</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {fieldList.map((field) => (
                    <tr key={field.id}>
                      <td className="capitalize text-slate-600">{field.entity_type}</td>
                      <td className="font-medium text-slate-800">{field.label}</td>
                      <td>
                        <code className="rounded bg-slate-100 px-1 text-xs">{field.key}</code>
                      </td>
                      <td className="text-slate-600">{field.field_type}</td>
                      <td className="text-slate-600">
                        {field.entity_type === 'contact' ? (
                          <span className="badge bg-slate-100 text-slate-600">
                            {CONTACT_CARD_LABELS[field.card] ?? field.card}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="text-slate-500">
                        {Array.isArray(field.options) && field.options.length > 0
                          ? (field.options as string[]).join(', ')
                          : '—'}
                      </td>
                      <td className="text-right">
                        <form action={deleteCustomField}>
                          <input type="hidden" name="id" value={field.id} />
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
            <p className="mt-3 text-xs text-slate-400">
              Deleting a definition hides the field from forms and filters. Values already stored on
              records are left untouched.
            </p>
          </Section>
        </div>

        <Section title="Add a field">
          <form action={createCustomField} className="space-y-3">
            <div>
              <label className="label" htmlFor="field-entity">
                Record type
              </label>
              <select id="field-entity" name="entity_type" className="input" defaultValue="contact">
                <option value="contact">Contact</option>
                <option value="company">Company</option>
              </select>
            </div>

            <div>
              <label className="label" htmlFor="field-label">
                Label
              </label>
              <input id="field-label" name="label" required className="input" placeholder="Account tier" />
            </div>

            <div>
              <label className="label" htmlFor="field-key">
                Key
              </label>
              <input id="field-key" name="key" className="input" placeholder="account_tier" />
              <p className="mt-1 text-xs text-slate-400">Derived from the label if left blank.</p>
            </div>

            <div>
              <label className="label" htmlFor="field-type">
                Type
              </label>
              <select id="field-type" name="field_type" className="input" defaultValue="text">
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
                <option value="boolean">Yes / no</option>
                <option value="select">Select</option>
                <option value="multiselect">Multi-select</option>
              </select>
            </div>

            <div>
              <label className="label" htmlFor="field-card">
                Card
              </label>
              <select id="field-card" name="card" className="input" defaultValue="additional">
                {CONTACT_CARDS.map((card) => (
                  <option key={card.key} value={card.key}>
                    {card.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-400">
                Which card the field appears on, for contacts.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="field-options">
                Options
              </label>
              <input id="field-options" name="options" className="input" placeholder="Gold, Silver, Bronze" />
              <p className="mt-1 text-xs text-slate-400">
                Comma separated. Select and multi-select fields only.
              </p>
            </div>

            <button type="submit" className="btn-primary w-full">
              Add field
            </button>
          </form>
        </Section>
      </div>
    </>
  )
}
