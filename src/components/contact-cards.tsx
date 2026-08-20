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
  hint,
  children,
}: {
  label: string
  /** A short aside after the label, e.g. "From the company record". */
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">
        {label}
        {hint && <span className="ml-1 font-normal text-slate-400">· {hint}</span>}
      </dt>
      <dd className="mt-1 text-sm text-slate-800">{children}</dd>
    </div>
  )
}

/** How many fields sit side by side in one row of a card. */
type FieldColumns = 1 | 2 | 3 | 4

const ROW_COLUMN_CLASSES: Record<FieldColumns, string> = {
  1: '',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
}

/**
 * One row of a card's field grid — however many fields belong together, side
 * by side.
 *
 * A row is its own small grid rather than a slice of one shared one. A field
 * that needs the full width is simply alone in its row, rather than spanning
 * columns across a grid whose column count changes at every breakpoint — a
 * span that is correct at one width and wrong at the next.
 *
 * Pairs with `divide-y` on the `<dl>` that holds these: the border between
 * rows comes from that, not from this component, so a row group produced by
 * `CustomFieldValues` gets the same line as one written by hand — divide-y
 * reads direct children, and a fragment's children count as the parent's.
 */
export function FieldRow({
  columns = 2,
  children,
}: {
  columns?: FieldColumns
  children: React.ReactNode
}) {
  return (
    <div className={`grid gap-3 py-3 first:pt-0 last:pb-0 ${ROW_COLUMN_CLASSES[columns]}`}>
      {children}
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
/** Groups a flat list into rows of `size`, the last row short rather than padded. */
function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = []
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size))
  return groups
}

/**
 * An admin's custom fields, laid out in the same row-and-line grid as the
 * fields around them.
 *
 * `columns` should match whatever the caller is using for its own `FieldRow`s
 * on the same card, so a custom field falls into the same rhythm as the
 * built-in ones rather than starting a mismatched grid of its own.
 */
export function CustomFieldValues({
  fields,
  values,
  fieldOptions = [],
  columns = 2,
  trailing,
}: {
  fields: { id: string; key: string; label: string; field_type: string; entity_type: string }[]
  values: Record<string, unknown>
  fieldOptions?: FieldOptionRow[]
  columns?: FieldColumns
  /**
   * One more field, laid out as though it were the last custom one.
   *
   * For a card that ends with a column of its own — a company's headcount after
   * its custom fields — where a row to itself would leave a half-empty line and
   * a row above them would put it before what it belongs after. It flows, so
   * defining another custom field pushes it along rather than displacing it.
   */
  trailing?: React.ReactNode
}) {
  const rendered = fields.map((field) => {
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
  })

  return (
    <>
      {chunk(trailing ? [...rendered, trailing] : rendered, columns).map((group, index) => (
        <FieldRow key={index} columns={columns}>
          {group}
        </FieldRow>
      ))}
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
