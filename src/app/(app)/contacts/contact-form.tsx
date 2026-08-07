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
import { CONTACT_CARDS, OPTION_COLOR_CLASSES } from '@/lib/field-options'
import { PlusIcon } from '@/components/icons'

import type { ActionState } from './actions'

const STAGES: LifecycleStage[] = ['lead', 'qualified', 'customer', 'other']

/**
 * Multi-select rendered as toggleable chips in each option's own colour, so the
 * form and the record read the same way. Backed by real checkboxes, which keeps
 * it keyboard-accessible and lets the values post without any client wiring.
 */
function ChipGroup({
  name,
  options,
  selected,
}: {
  name: string
  options: FieldOptionRow[]
  selected: string[]
}) {
  if (options.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        No options defined.{' '}
        <Link href="/settings/field-options" className="text-brand-700 hover:underline">
          Add some
        </Link>
      </p>
    )
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <label
          key={option.id}
          className="group cursor-pointer"
          title={option.value}
        >
          <input
            type="checkbox"
            name={name}
            value={option.value}
            defaultChecked={selected.includes(option.value)}
            className="peer sr-only"
          />
          <span
            className={`badge border border-transparent transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/40 ${OPTION_COLOR_CLASSES[option.color]} opacity-45 grayscale peer-checked:opacity-100 peer-checked:grayscale-0`}
          >
            {option.value}
          </span>
        </label>
      ))}
    </div>
  )
}

/** Single-select rendered as radio chips, with a clear option. */
function RadioChips({
  name,
  options,
  selected,
}: {
  name: string
  options: FieldOptionRow[]
  selected: string | null
}) {
  if (options.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        No options defined.{' '}
        <Link href="/settings/field-options" className="text-brand-700 hover:underline">
          Add some
        </Link>
      </p>
    )
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      <label className="cursor-pointer">
        <input
          type="radio"
          name={name}
          value=""
          defaultChecked={!selected}
          className="peer sr-only"
        />
        <span className="badge bg-white text-slate-500 ring-1 ring-slate-200 peer-checked:ring-2 peer-checked:ring-slate-400">
          None
        </span>
      </label>
      {options.map((option) => (
        <label key={option.id} className="cursor-pointer">
          <input
            type="radio"
            name={name}
            value={option.value}
            defaultChecked={selected === option.value}
            className="peer sr-only"
          />
          <span
            className={`badge transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/40 ${OPTION_COLOR_CLASSES[option.color]} opacity-45 grayscale peer-checked:opacity-100 peer-checked:grayscale-0`}
          >
            {option.value}
          </span>
        </label>
      ))}
    </div>
  )
}

/**
 * Notes editor. Markdown in a textarea rather than a rich-text surface: the
 * stored value is rendered back into the page, and markdown can be escaped
 * before formatting, so a note can never carry markup of its own.
 */
function NotesEditor({ defaultValue }: { defaultValue: string }) {
  const [value, setValue] = useState(defaultValue)

  function wrap(before: string, after = before) {
    const el = document.getElementById('notes') as HTMLTextAreaElement | null
    if (!el) return

    const { selectionStart: start, selectionEnd: end } = el
    const selected = value.slice(start, end) || 'text'
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`
    setValue(next)

    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + before.length, start + before.length + selected.length)
    })
  }

  function prefixLine(prefix: string) {
    const el = document.getElementById('notes') as HTMLTextAreaElement | null
    if (!el) return
    const start = value.lastIndexOf('\n', el.selectionStart - 1) + 1
    setValue(`${value.slice(0, start)}${prefix}${value.slice(start)}`)
    requestAnimationFrame(() => el.focus())
  }

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap gap-1">
        {[
          { label: 'B', title: 'Bold', run: () => wrap('**'), className: 'font-bold' },
          { label: 'I', title: 'Italic', run: () => wrap('*'), className: 'italic' },
          { label: '</>', title: 'Code', run: () => wrap('`'), className: 'font-mono text-[10px]' },
          { label: 'H', title: 'Heading', run: () => prefixLine('## '), className: 'font-semibold' },
          { label: '• List', title: 'Bullet list', run: () => prefixLine('- '), className: '' },
          { label: '1. List', title: 'Numbered list', run: () => prefixLine('1. '), className: '' },
          { label: 'Link', title: 'Link', run: () => wrap('[', '](https://)'), className: '' },
        ].map((button) => (
          <button
            key={button.label}
            type="button"
            title={button.title}
            onClick={button.run}
            className={`rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 ${button.className}`}
          >
            {button.label}
          </button>
        ))}
      </div>
      <textarea
        id="notes"
        name="notes"
        rows={6}
        className="input font-mono text-xs leading-relaxed"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={'Meeting notes, preferences, history…\n\n- **Bold** for emphasis\n- [Links](https://example.com) work too'}
      />
      <p className="mt-1 text-xs text-slate-400">
        Markdown: **bold**, *italic*, `code`, ## heading, - list, [label](url)
      </p>
    </div>
  )
}

/** Repeater for the named URLs on the Digital card. */
function LinksEditor({ defaultValue }: { defaultValue: ContactLink[] }) {
  const [links, setLinks] = useState<ContactLink[]>(defaultValue)

  function update(index: number, patch: Partial<ContactLink>) {
    setLinks(links.map((link, i) => (i === index ? { ...link, ...patch } : link)))
  }

  return (
    <div className="space-y-2">
      {/* Serialised into one field: the row count is dynamic, and a JSON blob
          avoids inventing an indexed naming scheme the action has to unpick. */}
      <input type="hidden" name="links" value={JSON.stringify(links.filter((link) => link.url.trim()))} />

      {links.map((link, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input
            className="input max-w-40"
            placeholder="Label"
            value={link.label}
            onChange={(event) => update(index, { label: event.target.value })}
            aria-label={`Link ${index + 1} label`}
          />
          <input
            className="input min-w-0 flex-1"
            placeholder="https://…"
            value={link.url}
            onChange={(event) => update(index, { url: event.target.value })}
            aria-label={`Link ${index + 1} URL`}
          />
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:text-red-600"
            onClick={() => setLinks(links.filter((_, i) => i !== index))}
            aria-label={`Remove link ${index + 1}`}
          >
            ✕
          </button>
        </div>
      ))}

      <button
        type="button"
        className="btn-secondary"
        onClick={() => setLinks([...links, { label: '', url: '' }])}
      >
        <PlusIcon className="h-4 w-4" />
        Add link
      </button>
    </div>
  )
}

function CustomFieldInputs({
  fields,
  values,
}: {
  fields: CustomFieldDefinitionRow[]
  values: Record<string, unknown>
}) {
  return (
    <>
      {fields.map((field) => {
        const raw = values[field.key]
        const options = Array.isArray(field.options) ? (field.options as string[]).map(String) : []
        const id = `custom.${field.key}`

        if (field.field_type === 'multiselect') {
          const selected = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
          return (
            <div key={field.id} className="sm:col-span-2">
              <span className="label">{field.label}</span>
              <div className="flex flex-wrap gap-1.5">
                {options.map((option) => (
                  <label key={option} className="cursor-pointer">
                    <input
                      type="checkbox"
                      name={id}
                      value={option}
                      defaultChecked={selected.includes(option)}
                      className="peer sr-only"
                    />
                    <span className="badge bg-slate-100 text-slate-600 opacity-50 peer-checked:bg-brand-100 peer-checked:text-brand-700 peer-checked:opacity-100">
                      {option}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )
        }

        const value = raw === undefined || raw === null ? '' : String(raw)

        return (
          <div key={field.id}>
            <label className="label" htmlFor={id}>
              {field.label}
            </label>
            {field.field_type === 'select' ? (
              <select id={id} name={id} className="input" defaultValue={value}>
                <option value="">—</option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                name={id}
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
    </>
  )
}

export function ContactForm({
  action,
  contact,
  companies,
  owners,
  customFields,
  fieldOptions,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>
  contact?: ContactRow
  companies: { id: string; name: string }[]
  owners: UserRow[]
  customFields: CustomFieldDefinitionRow[]
  fieldOptions: FieldOptionRow[]
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
          <label className="label" htmlFor="company_id">
            Company
          </label>
          <select id="company_id" name="company_id" className="input" defaultValue={contact?.company_id ?? ''}>
            <option value="">—</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
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
        <div className="sm:col-span-2">
          <span className="label">Specialty market</span>
          <ChipGroup
            name="specialty_market"
            options={optionsFor('specialty_market')}
            selected={contact?.specialty_market ?? []}
          />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Customer type</span>
          <ChipGroup
            name="customer_type"
            options={optionsFor('customer_type')}
            selected={contact?.customer_type ?? []}
          />
        </div>
        <CustomFieldInputs fields={customByCard('details')} values={custom} />
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
        <CustomFieldInputs fields={customByCard('influence')} values={custom} />
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
        <CustomFieldInputs fields={customByCard('additional')} values={custom} />
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
        <CustomFieldInputs fields={customByCard('digital')} values={custom} />
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

function FormCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="card p-5">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="text-xs text-slate-500">{description}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  )
}
