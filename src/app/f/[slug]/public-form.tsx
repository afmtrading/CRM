'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import type { ActionState } from '@/components/action-form'
import type { FormField } from '@/lib/forms'

import { submitForm } from './actions'

/**
 * The form a stranger fills in.
 *
 * Written as a real <form> with a server action rather than a fetch, so it
 * still works with JavaScript switched off — which is not a hypothetical for a
 * page whose whole job is to be embedded in somebody else's website and opened
 * on somebody else's phone.
 *
 * On success the form is replaced rather than annotated. A thank-you note under
 * a form that is still sitting there, still filled in, still with a live
 * button, is an invitation to press it again.
 */
export function PublicForm({
  slug,
  fields,
  submitLabel,
  consentBasis,
  consentLabel,
  consentRequired,
  brandColor,
  meta,
}: {
  slug: string
  fields: FormField[]
  submitLabel: string
  consentBasis: string
  consentLabel: string
  consentRequired: boolean
  brandColor: string
  /** Captured when the page rendered — see the note on referer in page.tsx. */
  meta: { page_url: string; referrer: string; utm: Record<string, string> }
}) {
  const [state, action] = useActionState(submitForm, {} as ActionState)

  if (state.ok) {
    return (
      <div
        role="status"
        className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-5 text-sm text-emerald-800"
      >
        {state.ok}
      </div>
    )
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="page_url" value={meta.page_url} />
      <input type="hidden" name="referrer" value={meta.referrer} />
      <input type="hidden" name="utm" value={JSON.stringify(meta.utm)} />

      {/*
        The honeypot. Not `display:none` — some bots skip anything hidden that
        way — but moved off-screen, unlabelled to a screen reader, and out of
        the tab order, so a person never meets it and a robot filling in every
        input it finds does.
      */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Leave this empty</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {fields.map((field) => (
        <Field key={field.key} field={field} />
      ))}

      {consentBasis === 'express' && (
        <label className="flex gap-2.5 text-sm text-slate-600">
          <input
            type="checkbox"
            name="consent"
            required={consentRequired}
            className="mt-0.5 shrink-0"
          />
          <span>{consentLabel}</span>
        </label>
      )}

      {state.error && (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      )}

      <Submit label={submitLabel} brandColor={brandColor} />
    </form>
  )
}

function Field({ field }: { field: FormField }) {
  const id = `q-${field.key}`
  const name = `q.${field.key}`

  const label = (
    <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor={id}>
      {field.label}
      {field.required && (
        <span className="ml-1 text-red-600" aria-hidden="true">
          *
        </span>
      )}
    </label>
  )

  const hint = field.help ? <p className="mt-1 text-xs text-slate-500">{field.help}</p> : null

  if (field.type === 'checkbox') {
    return (
      <div>
        <label className="flex gap-2.5 text-sm text-slate-700" htmlFor={id}>
          <input
            id={id}
            name={name}
            type="checkbox"
            required={field.required}
            className="mt-0.5 shrink-0"
          />
          <span>{field.label}</span>
        </label>
        {hint}
      </div>
    )
  }

  if (field.type === 'textarea') {
    return (
      <div>
        {label}
        <textarea
          id={id}
          name={name}
          rows={4}
          required={field.required}
          placeholder={field.placeholder || undefined}
          className="input"
        />
        {hint}
      </div>
    )
  }

  if (field.type === 'select') {
    return (
      <div>
        {label}
        <select id={id} name={name} required={field.required} className="input" defaultValue="">
          <option value="" disabled>
            Choose one
          </option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {hint}
      </div>
    )
  }

  return (
    <div>
      {label}
      <input
        id={id}
        name={name}
        // The keyboard a phone puts up is decided by this, which is most of the
        // reason the question types exist at all.
        type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'number' ? 'number' : 'text'}
        inputMode={field.type === 'phone' ? 'tel' : undefined}
        autoComplete={
          field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : undefined
        }
        required={field.required}
        placeholder={field.placeholder || undefined}
        className="input"
      />
      {hint}
    </div>
  )
}

/**
 * Its own component because useFormStatus reads the form it is rendered inside
 * — a hook up in PublicForm would be watching that component's parent instead.
 */
function Submit({ label, brandColor }: { label: string; brandColor: string }) {
  const { pending } = useFormStatus()

  return (
    <button
      type="submit"
      disabled={pending}
      // The organization's own colour, so an embedded form looks like it
      // belongs to the site it is embedded in rather than to this CRM.
      style={{ backgroundColor: brandColor }}
      className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Sending…' : label}
    </button>
  )
}
