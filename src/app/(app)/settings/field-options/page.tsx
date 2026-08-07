import { requireAdmin, scoped } from '@/lib/tenancy'
import type { FieldOptionRow } from '@/lib/database.types'
import {
  CONTACT_CARD_LABELS,
  OPTION_COLORS,
  OPTION_COLOR_CLASSES,
  OPTION_COLOR_SWATCHES,
  OPTION_FIELDS,
} from '@/lib/field-options'
import { PageHeader, Section } from '@/components/ui'
import { PlusIcon } from '@/components/icons'

import { createFieldOption, deleteFieldOption, updateFieldOptionColor } from '../actions'

export const metadata = { title: 'Field options · FLO CRM' }

export default async function FieldOptionsPage() {
  const context = await requireAdmin()

  const { data } = await scoped(context, 'field_options').select('*').order('order')
  const options = (data ?? []) as FieldOptionRow[]

  return (
    <>
      <PageHeader
        title="Field options"
        description="The values behind the select fields on a contact, and the colour each one is shown in. These lists belong to your organization — changing them here changes them everywhere, without a deploy."
      />

      <div className="grid gap-5 xl:grid-cols-2">
        {OPTION_FIELDS.map((field) => {
          const values = options.filter((option) => option.field_key === field.key)

          return (
            <Section
              key={field.key}
              title={field.label}
              actions={
                <span className="text-xs text-slate-500">
                  {CONTACT_CARD_LABELS[field.card]} · {field.multiple ? 'multiple' : 'single'} choice
                </span>
              }
            >
              {values.length === 0 ? (
                <p className="mb-4 text-sm text-slate-500">No options yet.</p>
              ) : (
                <ul className="mb-4 space-y-2">
                  {values.map((option) => (
                    <li key={option.id} className="flex flex-wrap items-center gap-2">
                      <span className={`badge ${OPTION_COLOR_CLASSES[option.color]}`}>
                        {option.value}
                      </span>

                      {/* Colour changes save on selection — one control, no
                          separate save button to forget. */}
                      <form action={updateFieldOptionColor} className="flex items-center gap-1.5">
                        <input type="hidden" name="id" value={option.id} />
                        <select
                          name="color"
                          defaultValue={option.color}
                          className="input max-w-32 py-1 text-xs"
                          aria-label={`Colour for ${option.value}`}
                        >
                          {OPTION_COLORS.map((color) => (
                            <option key={color} value={color}>
                              {color}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className="btn-secondary px-2 py-1 text-xs">
                          Apply
                        </button>
                      </form>

                      <form action={deleteFieldOption} className="ml-auto">
                        <input type="hidden" name="id" value={option.id} />
                        <button
                          type="submit"
                          className="px-1.5 text-sm text-slate-300 hover:text-red-600"
                          aria-label={`Delete ${option.value}`}
                        >
                          ✕
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}

              <form
                action={createFieldOption}
                className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4"
              >
                <input type="hidden" name="field_key" value={field.key} />
                <div className="min-w-0 flex-1">
                  <label className="label" htmlFor={`value-${field.key}`}>
                    New option
                  </label>
                  <input
                    id={`value-${field.key}`}
                    name="value"
                    required
                    className="input"
                    placeholder="Value"
                  />
                </div>
                <div>
                  <label className="label" htmlFor={`color-${field.key}`}>
                    Colour
                  </label>
                  <select id={`color-${field.key}`} name="color" className="input max-w-32" defaultValue="slate">
                    {OPTION_COLORS.map((color) => (
                      <option key={color} value={color}>
                        {color}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className="btn-primary">
                  <PlusIcon className="h-4 w-4" />
                  Add
                </button>
              </form>
            </Section>
          )
        })}
      </div>

      <div className="mt-5">
        <Section title="Palette">
          <p className="mb-3 text-sm text-slate-500">
            Colours come from a fixed palette so they stay legible and consistent across every list.
          </p>
          <div className="flex flex-wrap gap-2">
            {OPTION_COLORS.map((color) => (
              <span key={color} className={`badge ${OPTION_COLOR_CLASSES[color]}`}>
                <span className={`h-2 w-2 rounded-full ${OPTION_COLOR_SWATCHES[color]}`} aria-hidden />
                {color}
              </span>
            ))}
          </div>
        </Section>
      </div>
    </>
  )
}
