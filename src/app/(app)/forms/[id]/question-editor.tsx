'use client'

import { useState } from 'react'

import {
  FIELD_TYPES,
  fieldKey,
  whyNotPublishable,
  type FormField,
  type FormFieldType,
  type MappingTarget,
} from '@/lib/forms'
import { PlusIcon } from '@/components/icons'

/**
 * The questions, and what each one fills in.
 *
 * The second column is the part that makes this a CRM form rather than a survey
 * tool: an answer either fills a named field on the contact or it stays on the
 * submission. Everything absent from that list — the owner, the score, the
 * consent basis, the lifecycle stage — is decided by the form's settings or by
 * a rule, because those are the fields whose value a stranger would otherwise
 * be choosing.
 *
 * Serialised into one hidden input for the same reason LinksEditor is: the row
 * count is dynamic and the shapes differ by type, so a JSON blob beats an
 * indexed naming scheme the server action would have to unpick.
 */
export function QuestionEditor({
  defaultValue,
  targets,
}: {
  defaultValue: FormField[]
  /** The built-in columns plus this organization's custom contact fields. */
  targets: MappingTarget[]
}) {
  const [fields, setFields] = useState<FormField[]>(defaultValue)

  function update(index: number, patch: Partial<FormField>) {
    setFields(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)))
  }

  function move(index: number, delta: number) {
    const next = [...fields]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setFields(next)
  }

  function add() {
    const label = 'New question'
    setFields([
      ...fields,
      {
        key: fieldKey(label, fields.map((field) => field.key)),
        label,
        type: 'text',
        required: false,
        maps_to: '',
      },
    ])
  }

  // Said while they are looking at the questions, rather than after a round
  // trip. The database refuses the same thing; this is only the earlier voice.
  const problem = whyNotPublishable(fields)

  return (
    <div className="space-y-3">
      <input type="hidden" name="fields" value={JSON.stringify(fields)} />

      {fields.map((field, index) => (
        <div key={field.key} className="rounded-xl border border-slate-200 p-3.5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              <label className="label" htmlFor={`label-${field.key}`}>
                Question {index + 1}
              </label>
              <input
                id={`label-${field.key}`}
                className="input"
                value={field.label}
                maxLength={200}
                onChange={(event) => update(index, { label: event.target.value })}
              />
            </div>

            <div className="w-44">
              <label className="label" htmlFor={`type-${field.key}`}>
                Answer
              </label>
              <select
                id={`type-${field.key}`}
                className="input"
                value={field.type}
                onChange={(event) =>
                  update(index, { type: event.target.value as FormFieldType })
                }
              >
                {FIELD_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="w-56">
              <label className="label" htmlFor={`maps-${field.key}`}>
                Fills
              </label>
              <select
                id={`maps-${field.key}`}
                className="input"
                value={field.maps_to}
                onChange={(event) => update(index, { maps_to: event.target.value })}
              >
                {targets.map((target) => (
                  <option key={target.value} value={target.value}>
                    {target.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 pb-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(event) => update(index, { required: event.target.checked })}
              />
              Required
            </label>

            <div className="flex items-center gap-1 pb-1">
              <button
                type="button"
                className="btn-ghost px-2 py-1"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={`Move “${field.label}” up`}
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1"
                onClick={() => move(index, 1)}
                disabled={index === fields.length - 1}
                aria-label={`Move “${field.label}” down`}
                title="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:text-red-600"
                onClick={() => setFields(fields.filter((_, i) => i !== index))}
                aria-label={`Remove “${field.label}”`}
              >
                ✕
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`placeholder-${field.key}`}>
                Placeholder
              </label>
              <input
                id={`placeholder-${field.key}`}
                className="input"
                value={field.placeholder ?? ''}
                maxLength={200}
                onChange={(event) => update(index, { placeholder: event.target.value })}
              />
            </div>

            {field.type === 'select' ? (
              <div>
                <label className="label" htmlFor={`options-${field.key}`}>
                  Options, one per line
                </label>
                <textarea
                  id={`options-${field.key}`}
                  className="input"
                  rows={3}
                  value={(field.options ?? []).join('\n')}
                  onChange={(event) =>
                    update(index, {
                      options: event.target.value
                        .split('\n')
                        .map((option) => option.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </div>
            ) : (
              <div>
                <label className="label" htmlFor={`help-${field.key}`}>
                  Hint under the field
                </label>
                <input
                  id={`help-${field.key}`}
                  className="input"
                  value={field.help ?? ''}
                  maxLength={300}
                  onChange={(event) => update(index, { help: event.target.value })}
                />
              </div>
            )}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary" onClick={add}>
          <PlusIcon className="h-4 w-4" />
          Add a question
        </button>

        {problem && (
          <p className="text-xs text-amber-700" role="status">
            Cannot go live yet: {problem}
          </p>
        )}
      </div>
    </div>
  )
}
