'use client'

import { useActionState } from 'react'
import Link from 'next/link'

import type {
  CompanyAddress,
  CompanyRow,
  ContactCard,
  ContactLink,
  CustomFieldDefinitionRow,
  FieldOptionRow,
  OptionFieldKey,
  UserRow,
} from '@/lib/database.types'
import { COMPANY_CARDS } from '@/lib/field-options'
import {
  AddressesEditor,
  ChipGroup,
  CustomFieldInputs,
  FormCard,
  LinksEditor,
  NotesEditor,
} from '@/components/form-fields'

import type { CompanyActionState } from './actions'

export function CompanyForm({
  action,
  company,
  owners,
  customFields,
  fieldOptions,
  submitLabel,
}: {
  action: (state: CompanyActionState, formData: FormData) => Promise<CompanyActionState>
  company?: CompanyRow
  owners: UserRow[]
  customFields: CustomFieldDefinitionRow[]
  fieldOptions: FieldOptionRow[]
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as CompanyActionState)

  const custom = (company?.custom_fields ?? {}) as Record<string, unknown>
  const optionsFor = (key: OptionFieldKey) => fieldOptions.filter((o) => o.field_key === key)
  const customByCard = (card: ContactCard) => customFields.filter((field) => field.card === card)
  const links = Array.isArray(company?.links) ? (company.links as ContactLink[]) : []
  const addresses = Array.isArray(company?.addresses)
    ? (company.addresses as CompanyAddress[])
    : []

  return (
    <form action={formAction} className="space-y-5">
      {company && <input type="hidden" name="id" value={company.id} />}

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

      <FormCard title={COMPANY_CARDS[0].label} description={COMPANY_CARDS[0].description}>
        <div>
          <label className="label" htmlFor="name">
            Company name
          </label>
          <input id="name" name="name" required className="input" defaultValue={company?.name ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="domain">
            Website
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
          <label className="label" htmlFor="phone">
            Company phone
          </label>
          <input id="phone" name="phone" className="input" defaultValue={company?.phone ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="email">
            Company email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            className="input"
            defaultValue={company?.email ?? ''}
          />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Specialty market</span>
          <ChipGroup
            name="specialty_market"
            options={optionsFor('specialty_market')}
            selected={company?.specialty_market ?? []}
          />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Company type</span>
          <ChipGroup
            name="customer_type"
            options={optionsFor('customer_type')}
            selected={company?.customer_type ?? []}
          />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Addresses</span>
          <AddressesEditor defaultValue={addresses} />
        </div>
        <CustomFieldInputs fields={customByCard('details')} values={custom} />
      </FormCard>

      <FormCard title={COMPANY_CARDS[1].label} description={COMPANY_CARDS[1].description}>
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
        <CustomFieldInputs fields={customByCard('additional')} values={custom} />
        <div className="sm:col-span-2">
          <span className="label">Notes</span>
          <NotesEditor defaultValue={company?.notes ?? ''} id="company-notes" />
        </div>
      </FormCard>

      <FormCard title={COMPANY_CARDS[2].label} description={COMPANY_CARDS[2].description}>
        <div>
          <label className="label" htmlFor="linkedin">
            LinkedIn
          </label>
          <input id="linkedin" name="linkedin" className="input" placeholder="handle or URL" defaultValue={company?.linkedin ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="facebook">
            Facebook
          </label>
          <input id="facebook" name="facebook" className="input" placeholder="handle or URL" defaultValue={company?.facebook ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="instagram">
            Instagram
          </label>
          <input id="instagram" name="instagram" className="input" placeholder="handle or URL" defaultValue={company?.instagram ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="tiktok">
            TikTok
          </label>
          <input id="tiktok" name="tiktok" className="input" placeholder="handle or URL" defaultValue={company?.tiktok ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="x_twitter">
            X (Twitter)
          </label>
          <input id="x_twitter" name="x_twitter" className="input" placeholder="handle or URL" defaultValue={company?.x_twitter ?? ''} />
        </div>
        <CustomFieldInputs fields={customByCard('digital')} values={custom} />
        <div className="sm:col-span-2">
          <span className="label">Other links</span>
          <p className="mb-2 text-xs text-slate-400">
            Anything else worth keeping — a TikTok Shop, a distributor portal, a catalogue.
          </p>
          <LinksEditor defaultValue={links} />
        </div>
      </FormCard>

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
