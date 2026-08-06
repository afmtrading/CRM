'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'

import type {
  ContactRow,
  CustomFieldDefinitionRow,
  LifecycleStage,
  UserRow,
} from '@/lib/database.types'
import { contactName } from '@/lib/format'

import type { ActionState } from './actions'

const STAGES: LifecycleStage[] = ['lead', 'qualified', 'customer', 'other']

export function ContactForm({
  action,
  contact,
  companies,
  owners,
  customFields,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>
  contact?: ContactRow
  companies: { id: string; name: string }[]
  owners: UserRow[]
  customFields: CustomFieldDefinitionRow[]
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as ActionState)
  const [force, setForce] = useState(false)

  const custom = (contact?.custom_fields ?? {}) as Record<string, string>

  return (
    <form action={formAction} className="space-y-4">
      {contact && <input type="hidden" name="id" value={contact.id} />}
      <input type="hidden" name="force" value={force ? 'true' : 'false'} />

      {/*
        Acceptance criterion 6.2: saving a contact whose email already exists in
        this organization surfaces the existing record instead of quietly
        creating a second one.
      */}
      {state.duplicates && state.duplicates.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            {state.duplicates.length === 1
              ? 'A contact with these details already exists'
              : `${state.duplicates.length} existing contacts look like this one`}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {state.duplicates.map((duplicate) => (
              <li key={duplicate.id} className="flex items-center gap-2">
                <Link
                  href={`/contacts/${duplicate.id}`}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {contactName(duplicate)}
                </Link>
                <span className="text-slate-500">{duplicate.email ?? duplicate.phone ?? ''}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-amber-800">
            Open the existing record to add to it, or save this one as a separate contact and merge
            them later from the contact page.
          </p>
          <button
            type="submit"
            className="btn-secondary mt-3"
            onClick={() => setForce(true)}
            disabled={pending}
          >
            Save as a separate contact
          </button>
        </div>
      )}

      {state.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Saved.
        </p>
      )}

      <div className="card grid gap-4 p-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="first_name">
            First name
          </label>
          <input
            id="first_name"
            name="first_name"
            className="input"
            defaultValue={contact?.first_name ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="last_name">
            Last name
          </label>
          <input
            id="last_name"
            name="last_name"
            className="input"
            defaultValue={contact?.last_name ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            className="input"
            defaultValue={contact?.email ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="phone">
            Phone
          </label>
          <input id="phone" name="phone" className="input" defaultValue={contact?.phone ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="company_id">
            Company
          </label>
          <select
            id="company_id"
            name="company_id"
            className="input"
            defaultValue={contact?.company_id ?? ''}
          >
            <option value="">—</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="owner_id">
            Owner
          </label>
          <select id="owner_id" name="owner_id" className="input" defaultValue={contact?.owner_id ?? ''}>
            <option value="">Assign automatically</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name || owner.email}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="lifecycle_stage">
            Lifecycle stage
          </label>
          <select
            id="lifecycle_stage"
            name="lifecycle_stage"
            className="input"
            defaultValue={contact?.lifecycle_stage ?? 'lead'}
          >
            {STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {stage}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="source">
            Source
          </label>
          <input
            id="source"
            name="source"
            className="input"
            placeholder="website, referral, trade show…"
            defaultValue={contact?.source ?? ''}
          />
        </div>
      </div>

      {customFields.length > 0 && (
        <div className="card grid gap-4 p-4 sm:grid-cols-2">
          <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase sm:col-span-2">
            Custom fields
          </p>
          {customFields.map((field) => {
            const value = custom[field.key] ?? ''
            const options = Array.isArray(field.options) ? (field.options as string[]) : []

            return (
              <div key={field.id}>
                <label className="label" htmlFor={`custom.${field.key}`}>
                  {field.label}
                </label>
                {field.field_type === 'select' ? (
                  <select
                    id={`custom.${field.key}`}
                    name={`custom.${field.key}`}
                    className="input"
                    defaultValue={value}
                  >
                    <option value="">—</option>
                    {options.map((option) => (
                      <option key={String(option)} value={String(option)}>
                        {String(option)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`custom.${field.key}`}
                    name={`custom.${field.key}`}
                    className="input"
                    type={
                      field.field_type === 'number'
                        ? 'number'
                        : field.field_type === 'date'
                          ? 'date'
                          : 'text'
                    }
                    defaultValue={value}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </button>
        <Link href={contact ? `/contacts/${contact.id}` : '/contacts'} className="btn-secondary">
          Cancel
        </Link>
      </div>
    </form>
  )
}
