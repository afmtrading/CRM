'use client'

import { useActionState } from 'react'
import Link from 'next/link'

import type { CompanyRow, CustomFieldDefinitionRow, UserRow } from '@/lib/database.types'

import type { CompanyActionState } from './actions'

export function CompanyForm({
  action,
  company,
  owners,
  customFields,
  submitLabel,
}: {
  action: (state: CompanyActionState, formData: FormData) => Promise<CompanyActionState>
  company?: CompanyRow
  owners: UserRow[]
  customFields: CustomFieldDefinitionRow[]
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as CompanyActionState)
  const custom = (company?.custom_fields ?? {}) as Record<string, string>

  return (
    <form action={formAction} className="space-y-4">
      {company && <input type="hidden" name="id" value={company.id} />}

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
          <label className="label" htmlFor="name">
            Name
          </label>
          <input id="name" name="name" required className="input" defaultValue={company?.name ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="domain">
            Domain
          </label>
          <input
            id="domain"
            name="domain"
            className="input"
            placeholder="example.com"
            defaultValue={company?.domain ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="industry">
            Industry
          </label>
          <input id="industry" name="industry" className="input" defaultValue={company?.industry ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="owner_id">
            Owner
          </label>
          <select id="owner_id" name="owner_id" className="input" defaultValue={company?.owner_id ?? ''}>
            <option value="">—</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name || owner.email}
              </option>
            ))}
          </select>
        </div>
      </div>

      {customFields.length > 0 && (
        <div className="card grid gap-4 p-4 sm:grid-cols-2">
          <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase sm:col-span-2">
            Custom fields
          </p>
          {customFields.map((field) => (
            <div key={field.id}>
              <label className="label" htmlFor={`custom.${field.key}`}>
                {field.label}
              </label>
              <input
                id={`custom.${field.key}`}
                name={`custom.${field.key}`}
                className="input"
                type={
                  field.field_type === 'number' ? 'number' : field.field_type === 'date' ? 'date' : 'text'
                }
                defaultValue={custom[field.key] ?? ''}
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </button>
        <Link href={company ? `/companies/${company.id}` : '/companies'} className="btn-secondary">
          Cancel
        </Link>
      </div>
    </form>
  )
}
