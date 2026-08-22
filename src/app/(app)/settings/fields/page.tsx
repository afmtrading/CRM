import Link from 'next/link'

import { requireAdmin, scoped } from '@/lib/tenancy'
import type { CustomFieldDefinitionRow, FieldOptionRow } from '@/lib/database.types'
import {
  ALL_CARDS,
  OPTION_ENTITIES,
  cardLabel,
  OPTION_COLORS,
  OPTION_COLOR_CLASSES,
  OPTION_COLOR_SWATCHES,
  optionOwners,
  optionsForField,
} from '@/lib/field-options'
import { PageHeader, Section } from '@/components/ui'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { PlusIcon } from '@/components/icons'

import {
  createCustomField,
  createFieldOption,
  deleteCustomField,
} from '../actions'
import { FieldOptionRows } from './option-rows'

export const metadata = { title: 'Fields · FLO CRM' }

const TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / no',
  select: 'Select',
  multiselect: 'Multi-select',
}

export default async function FieldsPage({
  searchParams,
}: {
  searchParams: Promise<{ field?: string; entity?: string }>
}) {
  const { field: selectedKey, entity: selectedEntity } = await searchParams
  const context = await requireAdmin()

  const [{ data: definitions }, { data: optionRows }] = await Promise.all([
    scoped(context, 'custom_field_definitions').select('*').order('entity_type').order('order'),
    scoped(context, 'field_options').select('*').order('order'),
  ])

  const customFields = (definitions ?? []) as CustomFieldDefinitionRow[]
  const options = (optionRows ?? []) as FieldOptionRow[]

  // Built-in select fields and custom ones appear in one list — from an admin's
  // point of view they are the same thing, and it was never obvious why editing
  // one meant a different page from editing the other.
  const owners = optionOwners(customFields)
  const selected =
    owners.find((owner) => owner.key === selectedKey && owner.entity === selectedEntity) ??
    owners[0]

  const selectedOptions = selected
    ? (optionsForField(options, selected.entity, selected.key) as FieldOptionRow[])
    : []

  return (
    <>
      <PageHeader title="Fields" />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5">
          <Section title="Fields with options">
            <ul className="-mx-2 space-y-0.5">
              {owners.map((owner) => {
                const isSelected = selected?.key === owner.key && selected.entity === owner.entity
                const count = optionsForField(options, owner.entity, owner.key).length

                return (
                  <li key={`${owner.entity}.${owner.key}`}>
                    <Link
                      href={`/settings/fields?field=${owner.key}&entity=${owner.entity}`}
                      className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                        isSelected
                          ? 'bg-brand-50 font-medium text-brand-700'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{owner.label}</span>
                      <span className="shrink-0 text-xs text-slate-400 capitalize">
                        {owner.entity}
                      </span>
                      <span
                        className={`badge shrink-0 ${
                          isSelected ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {count}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
            <p className="mt-3 text-xs text-slate-400">
              Built-in fields cannot be removed, but their values are yours to change.
            </p>
          </Section>

          <Section title="Add a field">
            <ActionForm action={createCustomField} className="space-y-3">
              <div>
                <label className="label" htmlFor="field-entity">
                  Record type
                </label>
                <select id="field-entity" name="entity_type" className="input" defaultValue="contact">
                  {OPTION_ENTITIES.map((entity) => (
                    <option key={entity.value} value={entity.value}>
                      {entity.label}
                    </option>
                  ))}
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
                  {ALL_CARDS.map((card) => (
                    <option key={card.key} value={card.key}>
                      {card.label}
                    </option>
                  ))}
                </select>
              </div>

              <p className="text-xs text-slate-400">
                Choose Select or Multi-select and the field appears in the list above, ready for its
                values.
              </p>

              <SubmitButton className="btn-primary w-full" pendingLabel="Adding…">
                <PlusIcon className="h-4 w-4" />
                Add field
              </SubmitButton>
            </ActionForm>
          </Section>
        </div>

        <div className="space-y-5 lg:col-span-2">
          {selected && (
            <Section
              title={`${selected.label} options`}
              actions={
                <span className="text-xs text-slate-500">
                  <span className="capitalize">{selected.entity}</span> ·{' '}
                  {cardLabel(selected.entity, selected.card)} ·{' '}
                  {selected.multiple ? 'multiple' : 'single'} choice
                </span>
              }
            >
              <FieldOptionRows options={selectedOptions} />

              <ActionForm
                action={createFieldOption}
                className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4"
              >
                <input type="hidden" name="field_key" value={selected.key} />
                <input type="hidden" name="entity_type" value={selected.entity} />
                <div className="min-w-0 flex-1">
                  <label className="label" htmlFor="new-option">
                    New value
                  </label>
                  <input id="new-option" name="value" required className="input" placeholder="Value" />
                </div>
                <div>
                  <label className="label" htmlFor="new-option-color">
                    Colour
                  </label>
                  <select id="new-option-color" name="color" className="input max-w-32" defaultValue="slate">
                    {OPTION_COLORS.map((color) => (
                      <option key={color} value={color}>
                        {color}
                      </option>
                    ))}
                  </select>
                </div>
                <SubmitButton className="btn-primary" pendingLabel="Adding…">
                  <PlusIcon className="h-4 w-4" />
                  Add
                </SubmitButton>
              </ActionForm>

              <div className="mt-4 border-t border-slate-100 pt-4">
                <p className="mb-2 text-xs text-slate-500">
                  Colours come from a fixed palette so they stay legible across every list.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {OPTION_COLORS.map((color) => (
                    <span key={color} className={`badge ${OPTION_COLOR_CLASSES[color]}`}>
                      <span
                        className={`h-2 w-2 rounded-full ${OPTION_COLOR_SWATCHES[color]}`}
                        aria-hidden
                      />
                      {color}
                    </span>
                  ))}
                </div>
              </div>
            </Section>
          )}

          <Section title="All custom fields">
            {customFields.length === 0 ? (
              <p className="text-sm text-slate-500">No custom fields defined yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Record</th>
                      <th>Label</th>
                      <th>Key</th>
                      <th>Type</th>
                      <th>Card</th>
                      <th>Options</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {customFields.map((field) => {
                      const count = optionsForField(options, field.entity_type, field.key).length
                      const hasOptions =
                        field.field_type === 'select' || field.field_type === 'multiselect'

                      return (
                        <tr key={field.id}>
                          <td className="text-slate-600 capitalize">{field.entity_type}</td>
                          <td className="font-medium text-slate-800">{field.label}</td>
                          <td>
                            <code className="rounded bg-slate-100 px-1 text-xs">{field.key}</code>
                          </td>
                          <td className="text-slate-600">
                            {TYPE_LABELS[field.field_type] ?? field.field_type}
                          </td>
                          <td className="text-slate-600">
                            <span className="badge bg-slate-100 text-slate-600">
                              {cardLabel(field.entity_type, field.card)}
                            </span>
                          </td>
                          <td>
                            {hasOptions ? (
                              <Link
                                href={`/settings/fields?field=${field.key}&entity=${field.entity_type}`}
                                className="text-brand-700 hover:underline"
                              >
                                {count} value{count === 1 ? '' : 's'}
                              </Link>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
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
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-slate-400">
              Deleting a definition hides the field from forms and filters, and removes its option
              list. Values already stored on records are left untouched.
            </p>
          </Section>
        </div>
      </div>
    </>
  )
}
