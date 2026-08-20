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
  TagRow,
  UserRow,
} from '@/lib/database.types'
import { COMPANY_CARDS, optionsForField } from '@/lib/field-options'
import {
  AddressesEditor,
  ChipGroup,
  CustomFieldInputs,
  FormCard,
  LinksEditor,
  NotesEditor,
  RadioChips,
} from '@/components/form-fields'
import { TagPicker } from '@/components/tag-picker'

import type { CompanyActionState } from './actions'

export function CompanyForm({
  action,
  company,
  owners,
  customFields,
  fieldOptions,
  countries,
  tags,
  selectedTagIds = [],
  canManage = false,
  submitLabel,
}: {
  action: (state: CompanyActionState, formData: FormData) => Promise<CompanyActionState>
  company?: CompanyRow
  owners: UserRow[]
  customFields: CustomFieldDefinitionRow[]
  fieldOptions: FieldOptionRow[]
  /** ISO 3166, from the database rather than a second copy in the bundle. */
  countries: { code: string; name: string; kind?: string }[]
  /** The organization's tags, shared with contacts and products. */
  tags: TagRow[]
  /** Empty on a new company, which is the point — it can be tagged as it is created. */
  selectedTagIds?: string[]
  /** Only an admin is offered the link to Settings → Tags. */
  canManage?: boolean
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as CompanyActionState)

  const custom = (company?.custom_fields ?? {}) as Record<string, unknown>
  // Scoped to this record's own options, not just the key — see optionsForField.
  const optionsFor = (key: OptionFieldKey) => optionsForField(fieldOptions, 'company', key)
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
          <span className="label">Addresses</span>
          <AddressesEditor defaultValue={addresses} />
        </div>
        <CustomFieldInputs
          fields={customByCard('details')}
          values={custom}
          fieldOptions={fieldOptions}
        />
      </FormCard>

      {/* Second, so the form reads in the order the record does. */}
      <FormCard title={COMPANY_CARDS[3].label} description={COMPANY_CARDS[3].description}>
        <div className="sm:col-span-2">
          <span className="label">Merchandise</span>
          <ChipGroup
            name="specialty_market"
            options={optionsFor('specialty_market')}
            selected={company?.specialty_market ?? []}
          />
        </div>
        {/*
          What category of goods, and what condition they arrive in, are two
          questions. A buyer of medical overstock and a buyer of medical
          customer returns are not the same call.
        */}
        <div className="sm:col-span-2">
          <span className="label">Stock type</span>
          <ChipGroup
            name="stock_type"
            options={optionsFor('stock_type')}
            selected={company?.stock_type ?? []}
          />
        </div>
        {/*
          Where they are, and where they trade — three separate questions, and
          the last two are the ones worth filtering on. "In Ontario" and
          "selling across North America" are different facts about the same
          company, and until these existed both lived in one free-text line.

          Plain multiple-selects rather than chips: there are 249 countries, and
          a chip for each is a wall. The browser's own control handles a long
          list, filters as you type, and needs no client bundle.
        */}
        <div>
          <label className="label" htmlFor="company-based-in">
            Base Country
          </label>
          <select
            id="company-based-in"
            name="based_in"
            defaultValue={company?.based_in ?? ''}
            className="input"
          >
            <option value="">Not known</option>
            {/*
              The trading regions lead, under their own heading. They are
              already first in the list because the query orders them that way;
              the heading is what stops "North America" reading as a country
              somebody has not heard of.
            */}
            <optgroup label="Regions">
              {countries
                .filter((country) => country.kind === 'region')
                .map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Countries">
              {countries
                .filter((country) => country.kind !== 'region')
                .map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
            </optgroup>
          </select>
        </div>


        <div>
          <label className="label" htmlFor="company-sells-in">
            Sells To
          </label>
          <select
            id="company-sells-in"
            name="sells_in"
            multiple
            size={7}
            defaultValue={company?.sells_in ?? []}
            className="input h-auto"
          >
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Every country they sell into. Hold Ctrl or Cmd to pick more than one.
          </p>
        </div>


        <div className="sm:col-span-2">
          <span className="label">Company type</span>
          <ChipGroup
            name="customer_type"
            options={optionsFor('customer_type')}
            selected={company?.customer_type ?? []}
          />
        </div>

        {/*
          The company's own list, not the contacts' one — a Critical account can
          have a Standard person at it, and one list would make those the same
          statement. Both are seeded identically, so they agree until somebody
          deliberately changes one.
        */}
        <div>
          <span className="label">Priority</span>
          {/*
            Chips, like every other option field on this form and like the
            priority on a contact. It was the one select among them, which made
            the same question look like a different kind of question depending
            on which record you were looking at.
          */}
          <RadioChips
            name="priority"
            options={optionsFor('priority')}
            selected={company?.priority ?? null}
          />
        </div>
        <CustomFieldInputs
          fields={customByCard('rating')}
          values={custom}
          fieldOptions={fieldOptions}
        />
      </FormCard>

      {/*
        Asked while the company is being created, not only afterwards. The
        marker field is what tells the action this form asked at all — an empty
        checklist posts nothing, and without it an untagged save would look the
        same as a screen that never offered the question.
      */}
      <FormCard title="Tags" description="Shared with contacts and products. Managed in Settings → Tags.">
        <div className="sm:col-span-2">
          <input type="hidden" name="tags_present" value="1" />
          <TagPicker tags={tags} selected={selectedTagIds} canManage={canManage} />
        </div>
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
        <CustomFieldInputs
          fields={customByCard('additional')}
          values={custom}
          fieldOptions={fieldOptions}
        />
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
        <div>
          <label className="label" htmlFor="youtube">
            YouTube
          </label>
          <input id="youtube" name="youtube" className="input" placeholder="handle or URL" defaultValue={company?.youtube ?? ''} />
        </div>
        <CustomFieldInputs
          fields={customByCard('digital')}
          values={custom}
          fieldOptions={fieldOptions}
        />
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
