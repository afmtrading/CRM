'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'

import type {
  ContactCard,
  ContactLink,
  ContactRow,
  CustomFieldDefinitionRow,
  FieldOptionRow,
  LifecycleStage,
  OptionFieldKey,
  UserRow,
} from '@/lib/database.types'
import { contactName } from '@/lib/format'
import { CONTACT_CARDS } from '@/lib/field-options'
import { CompanyPicker } from '@/components/company-picker'
import {
  ChipGroup,
  CustomFieldInputs,
  FormCard,
  LinksEditor,
  NotesEditor,
  RadioChips,
} from '@/components/form-fields'

import type { ActionState } from './actions'

const STAGES: LifecycleStage[] = ['lead', 'qualified', 'customer', 'other']

export function ContactForm({
  action,
  contact,
  companies,
  owners,
  customFields,
  fieldOptions,
  prefillCompanyId,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>
  contact?: ContactRow
  companies: { id: string; name: string }[]
  owners: UserRow[]
  customFields: CustomFieldDefinitionRow[]
  fieldOptions: FieldOptionRow[]
  /** Preselects the company when arriving from a company page. */
  prefillCompanyId?: string
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as ActionState)
  const [force, setForce] = useState(false)

  const custom = (contact?.custom_fields ?? {}) as Record<string, unknown>
  const optionsFor = (key: OptionFieldKey) => fieldOptions.filter((o) => o.field_key === key)
  const customByCard = (card: ContactCard) => customFields.filter((field) => field.card === card)
  const links = Array.isArray(contact?.links) ? (contact.links as ContactLink[]) : []

  return (
    <form action={formAction} className="space-y-5">
      {contact && <input type="hidden" name="id" value={contact.id} />}
      <input type="hidden" name="force" value={force ? 'true' : 'false'} />

      {/*
        Acceptance criterion 6.2: saving a contact whose email already exists in
        this organization surfaces the existing record instead of quietly
        creating a second one.
      */}
      {state.duplicates && state.duplicates.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
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
        <p className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          Saved.
        </p>
      )}

      {/* The form is grouped into the same cards as the record, so editing and
          reading a contact share one mental model. */}
      <FormCard title={CONTACT_CARDS[0].label} description={CONTACT_CARDS[0].description}>
        <div>
          <label className="label" htmlFor="first_name">
            First name
          </label>
          <input id="first_name" name="first_name" className="input" defaultValue={contact?.first_name ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="last_name">
            Last name
          </label>
          <input id="last_name" name="last_name" className="input" defaultValue={contact?.last_name ?? ''} />
        </div>
        <div>
          <span className="label">Company</span>
          <CompanyPicker
            companies={companies}
            defaultValue={contact?.company_id ?? prefillCompanyId}
          />
        </div>
        <div>
          <label className="label" htmlFor="job_title">
            Job title
          </label>
          <input
            id="job_title"
            name="job_title"
            className="input"
            placeholder="Head of Purchasing"
            defaultValue={contact?.job_title ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="email">
            Primary email
          </label>
          <input id="email" name="email" type="email" className="input" defaultValue={contact?.email ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="phone">
            Mobile phone
          </label>
          <input id="phone" name="phone" className="input" defaultValue={contact?.phone ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="office_phone">
            Office phone
          </label>
          <input
            id="office_phone"
            name="office_phone"
            className="input"
            defaultValue={contact?.office_phone ?? ''}
          />
        </div>
        <CustomFieldInputs
          fields={customByCard('details')}
          values={custom}
          fieldOptions={fieldOptions}
        />
      </FormCard>

      <FormCard title={CONTACT_CARDS[1].label} description={CONTACT_CARDS[1].description}>
        <div className="sm:col-span-2">
          <span className="label">Role type</span>
          <ChipGroup name="role_type" options={optionsFor('role_type')} selected={contact?.role_type ?? []} />
        </div>
        <div>
          <span className="label">Priority</span>
          <RadioChips name="priority" options={optionsFor('priority')} selected={contact?.priority ?? null} />
        </div>
        <div>
          <span className="label">Credibility</span>
          <RadioChips
            name="credibility"
            options={optionsFor('credibility')}
            selected={contact?.credibility ?? null}
          />
        </div>
        <CustomFieldInputs
          fields={customByCard('influence')}
          values={custom}
          fieldOptions={fieldOptions}
        />
      </FormCard>

      <FormCard title={CONTACT_CARDS[2].label} description={CONTACT_CARDS[2].description}>
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
        <div>
          <label className="label" htmlFor="birthday">
            Birthday
          </label>
          <input
            id="birthday"
            name="birthday"
            type="date"
            className="input"
            defaultValue={contact?.birthday ?? ''}
          />
          <p className="mt-1 text-xs text-slate-400">A reminder task appears three days before.</p>
        </div>
        <CustomFieldInputs
          fields={customByCard('additional')}
          values={custom}
          fieldOptions={fieldOptions}
        />
        <div className="sm:col-span-2">
          <span className="label">Notes</span>
          <NotesEditor defaultValue={contact?.notes ?? ''} />
        </div>
      </FormCard>

      <FormCard title={CONTACT_CARDS[3].label} description={CONTACT_CARDS[3].description}>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="website">
            Website
          </label>
          <input
            id="website"
            name="website"
            className="input"
            placeholder="Defaults to the company's domain"
            defaultValue={contact?.website ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="linkedin">
            LinkedIn
          </label>
          <input id="linkedin" name="linkedin" className="input" placeholder="handle or URL" defaultValue={contact?.linkedin ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="facebook">
            Facebook
          </label>
          <input id="facebook" name="facebook" className="input" placeholder="handle or URL" defaultValue={contact?.facebook ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="instagram">
            Instagram
          </label>
          <input id="instagram" name="instagram" className="input" placeholder="handle or URL" defaultValue={contact?.instagram ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="tiktok">
            TikTok
          </label>
          <input id="tiktok" name="tiktok" className="input" placeholder="handle or URL" defaultValue={contact?.tiktok ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="x_twitter">
            X (Twitter)
          </label>
          <input id="x_twitter" name="x_twitter" className="input" placeholder="handle or URL" defaultValue={contact?.x_twitter ?? ''} />
        </div>
        <CustomFieldInputs
          fields={customByCard('digital')}
          values={custom}
          fieldOptions={fieldOptions}
        />
        <div className="sm:col-span-2">
          <span className="label">Other links</span>
          <LinksEditor defaultValue={links} />
        </div>
      </FormCard>

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
