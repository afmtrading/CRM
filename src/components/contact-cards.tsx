import Link from 'next/link'

import type { FieldOptionRow, OptionColor } from '@/lib/database.types'
import { OPTION_COLOR_CLASSES, prettyUrl } from '@/lib/field-options'
import { MailIcon, PhoneIcon } from '@/components/icons'

/** A select option rendered in its configured colour. */
export function OptionBadge({ value, color }: { value: string; color: OptionColor }) {
  return <span className={`badge ${OPTION_COLOR_CLASSES[color]}`}>{value}</span>
}

/**
 * Looks an option's colour up by value. Falls back to a neutral badge when the
 * stored value is no longer in the list — an admin can rename or remove an
 * option, and a contact still holding the old value must not break the page.
 */
export function optionColor(options: FieldOptionRow[], value: string): OptionColor {
  return options.find((option) => option.value === value)?.color ?? 'slate'
}

export function OptionBadges({
  values,
  options,
}: {
  values: string[] | null | undefined
  options: FieldOptionRow[]
}) {
  if (!values || values.length === 0) return <Empty />
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <OptionBadge key={value} value={value} color={optionColor(options, value)} />
      ))}
    </div>
  )
}

export function Empty() {
  return <span className="text-slate-400">—</span>
}

/** One label/value pair inside a card. */
export function Field({
  label,
  children,
  wide = false,
}: {
  label: string
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm text-slate-800">{children}</dd>
    </div>
  )
}

/**
 * A phone number with a call button, or an email address with a compose
 * button. The action sits next to the value rather than replacing it, so the
 * number stays selectable and copyable.
 */
export function ContactMethod({
  value,
  kind,
  label,
}: {
  value: string | null | undefined
  kind: 'phone' | 'email'
  label: string
}) {
  if (!value?.trim()) return <Empty />

  const href = kind === 'phone' ? `tel:${value.replace(/[^\d+]/g, '')}` : `mailto:${value}`
  const Icon = kind === 'phone' ? PhoneIcon : MailIcon

  return (
    <span className="flex items-center gap-2">
      <span className="min-w-0 truncate">{value}</span>
      <a
        href={href}
        aria-label={`${kind === 'phone' ? 'Call' : 'Email'} ${label}`}
        title={kind === 'phone' ? `Call ${value}` : `Email ${value}`}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700"
      >
        <Icon className="h-3.5 w-3.5" />
        {kind === 'phone' ? 'Call' : 'Email'}
      </a>
    </span>
  )
}

/** An external link shown by its domain rather than its full URL. */
export function ExternalLink({ url, label }: { url: string | null; label?: string }) {
  if (!url) return <Empty />
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      // block, not inline: `truncate` relies on overflow, which an inline
      // element ignores — several links would run together on one line.
      className="block max-w-full truncate text-brand-700 hover:underline"
    >
      {label ?? prettyUrl(url)}
    </a>
  )
}

/**
 * Renders whatever custom fields an admin assigned to a given card.
 *
 * Select and multi-select values come back as coloured badges, using the same
 * option list the built-in select fields draw from — a custom field should not
 * look like a lesser citizen on the record.
 */
export function CustomFieldValues({
  fields,
  values,
  fieldOptions = [],
}: {
  fields: { id: string; key: string; label: string; field_type: string; entity_type: string }[]
  values: Record<string, unknown>
  fieldOptions?: FieldOptionRow[]
}) {
  return (
    <>
      {fields.map((field) => {
        const raw = values[field.key]
        const isEmpty = raw === undefined || raw === null || raw === ''

        if (field.field_type === 'select' || field.field_type === 'multiselect') {
          const options = fieldOptions.filter(
            (option) => option.entity_type === field.entity_type && option.field_key === field.key,
          )
          const list = Array.isArray(raw) ? raw.map(String) : isEmpty ? [] : [String(raw)]

          return (
            <Field key={field.id} label={field.label}>
              <OptionBadges values={list} options={options} />
            </Field>
          )
        }

        const display = Array.isArray(raw) ? raw.join(', ') : raw

        return (
          <Field key={field.id} label={field.label}>
            {isEmpty ? <Empty /> : String(display)}
          </Field>
        )
      })}
    </>
  )
}

export function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-brand-700 hover:underline">
      {children}
    </Link>
  )
}

/**
 * A custom field, in a table cell.
 *
 * The three lists all offer custom fields as columns, and a custom field's
 * value is whatever somebody typed into a jsonb blob — a string, a number, a
 * boolean, or an array from a multiselect. Rendering it is the same problem on
 * every page, so it is solved once here rather than three times.
 *
 * No option colours. A badge needs the field's palette, which means loading
 * field_options for every custom field on the list; plain text is honest and
 * costs nothing, and the record page shows it properly.
 */
export function CustomCell({
  row,
  columnKey,
}: {
  row: { custom_fields?: Record<string, unknown> | null }
  /** The catalogue key, e.g. `custom_fields.tier`. */
  columnKey: string
}) {
  if (!columnKey.startsWith('custom_fields.')) return <Empty />

  const value = row.custom_fields?.[columnKey.slice('custom_fields.'.length)]

  if (value === null || value === undefined || value === '') return <Empty />

  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== null && item !== '')
    return items.length === 0 ? (
      <Empty />
    ) : (
      <span className="block truncate text-slate-600">{items.join(', ')}</span>
    )
  }

  // A boolean reads as Yes/No rather than "true": nobody types "true" into a
  // checkbox, so nobody should have to read it back.
  if (typeof value === 'boolean') {
    return <span className="text-slate-600">{value ? 'Yes' : 'No'}</span>
  }

  return <span className="block truncate text-slate-600">{String(value)}</span>
}
