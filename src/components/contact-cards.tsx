import Link from 'next/link'

import type { FieldOptionRow, OptionColor } from '@/lib/database.types'
import { prettyUrl } from '@/lib/field-options'
import { MailIcon, PhoneIcon } from '@/components/icons'

/**
 * A stored option, as text.
 *
 * These used to be coloured pills. A record page carried a dozen of them and
 * the colour stopped meaning anything — every value shouted, so none of them
 * did. The words are the information; the page reads quieter without a palette
 * competing with it.
 *
 * The `color` argument is still taken and still ignored, so an admin's choices
 * survive in the database and the call sites do not all have to change if the
 * colours are ever wanted back.
 */
export function OptionBadge({ value }: { value: string; color?: OptionColor }) {
  return <span>{value}</span>
}

/**
 * Looks an option's colour up by value. Falls back to neutral when the stored
 * value is no longer in the list — an admin can rename or remove an option, and
 * a contact still holding the old value must not break the page.
 */
export function optionColor(options: FieldOptionRow[], value: string): OptionColor {
  return options.find((option) => option.value === value)?.color ?? 'slate'
}

/** Several of them, read as a list rather than stacked as chips. */
export function OptionBadges({
  values,
}: {
  values: string[] | null | undefined
  options?: FieldOptionRow[]
}) {
  if (!values || values.length === 0) return <Empty />
  return <span>{values.join(', ')}</span>
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
 * Select and multi-select values read the same as the built-in ones — a custom
 * field should not look like a lesser citizen on the record.
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
