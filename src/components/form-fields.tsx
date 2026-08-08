'use client'

import { useState } from 'react'
import Link from 'next/link'

import type {
  CompanyAddress,
  ContactLink,
  CustomFieldDefinitionRow,
  FieldOptionRow,
} from '@/lib/database.types'
import { OPTION_COLOR_CLASSES } from '@/lib/field-options'
import { PlusIcon } from '@/components/icons'

/** One card's worth of form fields, matching the cards on the record itself. */
export function FormCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="card p-5">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {description && <p className="text-xs text-slate-500">{description}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  )
}

function NoOptions() {
  return (
    <p className="text-xs text-slate-500">
      No options defined.{' '}
      <Link href="/settings/field-options" className="text-brand-700 hover:underline">
        Add some
      </Link>
    </p>
  )
}

/**
 * Multi-select rendered as toggleable chips in each option's own colour, so the
 * form and the record read the same way. Backed by real checkboxes, which keeps
 * it keyboard-accessible and lets the values post without any client wiring.
 */
export function ChipGroup({
  name,
  options,
  selected,
}: {
  name: string
  options: FieldOptionRow[]
  selected: string[]
}) {
  if (options.length === 0) return <NoOptions />

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <label key={option.id} className="cursor-pointer" title={option.value}>
          <input
            type="checkbox"
            name={name}
            value={option.value}
            defaultChecked={selected.includes(option.value)}
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

/** Single-select rendered as radio chips, with a way back to nothing selected. */
export function RadioChips({
  name,
  options,
  selected,
}: {
  name: string
  options: FieldOptionRow[]
  selected: string | null
}) {
  if (options.length === 0) return <NoOptions />

  return (
    <div className="flex flex-wrap gap-1.5">
      <label className="cursor-pointer">
        <input type="radio" name={name} value="" defaultChecked={!selected} className="peer sr-only" />
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
export function NotesEditor({ defaultValue, id = 'notes' }: { defaultValue: string; id?: string }) {
  const [value, setValue] = useState(defaultValue)

  function field() {
    return document.getElementById(id) as HTMLTextAreaElement | null
  }

  function wrap(before: string, after = before) {
    const el = field()
    if (!el) return

    const { selectionStart: start, selectionEnd: end } = el
    const selected = value.slice(start, end) || 'text'
    setValue(`${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`)

    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + before.length, start + before.length + selected.length)
    })
  }

  function prefixLine(prefix: string) {
    const el = field()
    if (!el) return
    const start = value.lastIndexOf('\n', el.selectionStart - 1) + 1
    setValue(`${value.slice(0, start)}${prefix}${value.slice(start)}`)
    requestAnimationFrame(() => el.focus())
  }

  const buttons = [
    { label: 'B', title: 'Bold', run: () => wrap('**'), className: 'font-bold' },
    { label: 'I', title: 'Italic', run: () => wrap('*'), className: 'italic' },
    { label: '</>', title: 'Code', run: () => wrap('`'), className: 'font-mono text-[10px]' },
    { label: 'H', title: 'Heading', run: () => prefixLine('## '), className: 'font-semibold' },
    { label: '• List', title: 'Bullet list', run: () => prefixLine('- '), className: '' },
    { label: '1. List', title: 'Numbered list', run: () => prefixLine('1. '), className: '' },
    { label: 'Link', title: 'Link', run: () => wrap('[', '](https://)'), className: '' },
  ]

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap gap-1">
        {buttons.map((button) => (
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
        id={id}
        name="notes"
        rows={6}
        className="input font-mono text-xs leading-relaxed"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={'Notes, preferences, history…\n\n- **Bold** for emphasis\n- [Links](https://example.com) work too'}
      />
      <p className="mt-1 text-xs text-slate-400">
        Markdown: **bold**, *italic*, `code`, ## heading, - list, [label](url)
      </p>
    </div>
  )
}

/**
 * Repeater for named URLs — the "and anything else" row on a Digital card,
 * such as a TikTok Shop or a distributor portal.
 */
export function LinksEditor({ defaultValue }: { defaultValue: ContactLink[] }) {
  const [links, setLinks] = useState<ContactLink[]>(defaultValue)

  return (
    <div className="space-y-2">
      {/* Serialised into one field: the row count is dynamic, and a JSON blob
          avoids inventing an indexed naming scheme the action has to unpick. */}
      <input type="hidden" name="links" value={JSON.stringify(links.filter((l) => l.url.trim()))} />

      {links.map((link, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input
            className="input max-w-40"
            placeholder="Label"
            value={link.label}
            onChange={(e) =>
              setLinks(links.map((l, i) => (i === index ? { ...l, label: e.target.value } : l)))
            }
            aria-label={`Link ${index + 1} label`}
          />
          <input
            className="input min-w-0 flex-1"
            placeholder="https://…"
            value={link.url}
            onChange={(e) =>
              setLinks(links.map((l, i) => (i === index ? { ...l, url: e.target.value } : l)))
            }
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

/** Repeater for labelled addresses — head office, warehouse, billing, and so on. */
export function AddressesEditor({ defaultValue }: { defaultValue: CompanyAddress[] }) {
  const [addresses, setAddresses] = useState<CompanyAddress[]>(defaultValue)

  return (
    <div className="space-y-3">
      <input
        type="hidden"
        name="addresses"
        value={JSON.stringify(addresses.filter((a) => a.address.trim()))}
      />

      {addresses.map((entry, index) => (
        <div key={index} className="flex flex-wrap items-start gap-2">
          <input
            className="input max-w-40"
            placeholder="Head office"
            value={entry.label}
            onChange={(e) =>
              setAddresses(
                addresses.map((a, i) => (i === index ? { ...a, label: e.target.value } : a)),
              )
            }
            aria-label={`Address ${index + 1} label`}
          />
          <textarea
            className="input min-w-0 flex-1"
            rows={2}
            placeholder="Street, city, postal code, country"
            value={entry.address}
            onChange={(e) =>
              setAddresses(
                addresses.map((a, i) => (i === index ? { ...a, address: e.target.value } : a)),
              )
            }
            aria-label={`Address ${index + 1}`}
          />
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:text-red-600"
            onClick={() => setAddresses(addresses.filter((_, i) => i !== index))}
            aria-label={`Remove address ${index + 1}`}
          >
            ✕
          </button>
        </div>
      ))}

      <button
        type="button"
        className="btn-secondary"
        onClick={() => setAddresses([...addresses, { label: '', address: '' }])}
      >
        <PlusIcon className="h-4 w-4" />
        Add address
      </button>
    </div>
  )
}

/** Renders whichever custom fields an admin assigned to the card being drawn. */
export function CustomFieldInputs({
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
