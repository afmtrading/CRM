import type { ContactCard, OptionColor, OptionFieldKey } from '@/lib/database.types'

/**
 * The cards a contact record is divided into. Custom fields pick one of these,
 * so an organization decides where its own fields appear.
 */
export const CONTACT_CARDS: { key: ContactCard; label: string; description: string }[] = [
  { key: 'details', label: 'Contact details', description: 'Who they are and how to reach them' },
  { key: 'influence', label: 'Influence', description: 'How much weight they carry in a deal' },
  { key: 'additional', label: 'Additional info', description: 'Ownership, scoring and notes' },
  { key: 'digital', label: 'Digital', description: 'Websites and social profiles' },
]

/**
 * The company equivalent. Reuses the same card keys so one custom-field
 * definition can be placed on either record without a second vocabulary.
 */
export const COMPANY_CARDS: { key: ContactCard; label: string; description: string }[] = [
  { key: 'details', label: 'Company info', description: 'What the business is and where to find it' },
  { key: 'additional', label: 'Additional info', description: 'Ownership and notes' },
  { key: 'digital', label: 'Digital', description: 'Website and social profiles' },
]

export const CONTACT_CARD_LABELS = Object.fromEntries(
  CONTACT_CARDS.map((card) => [card.key, card.label]),
) as Record<ContactCard, string>

export const COMPANY_CARD_LABELS = Object.fromEntries(
  COMPANY_CARDS.map((card) => [card.key, card.label]),
) as Record<ContactCard, string>

/**
 * Cards share their keys across both records but not their names — 'details' is
 * "Contact details" on a person and "Company info" on a business.
 */
export function cardLabel(entity: string, card: ContactCard): string {
  return entity === 'company'
    ? (COMPANY_CARD_LABELS[card] ?? CONTACT_CARD_LABELS[card] ?? card)
    : (CONTACT_CARD_LABELS[card] ?? card)
}

/**
 * Option colours resolve to fixed class strings rather than arbitrary hex, so
 * Tailwind can see every class at build time. The database constrains `color`
 * to exactly these names.
 */
export const OPTION_COLORS: OptionColor[] = [
  'slate',
  'blue',
  'green',
  'amber',
  'red',
  'violet',
  'cyan',
  'rose',
  'orange',
  'teal',
]

export const OPTION_COLOR_CLASSES: Record<OptionColor, string> = {
  slate: 'bg-slate-100 text-slate-700',
  blue: 'bg-blue-100 text-blue-700',
  green: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-700',
  violet: 'bg-violet-100 text-violet-700',
  cyan: 'bg-cyan-100 text-cyan-700',
  rose: 'bg-rose-100 text-rose-700',
  orange: 'bg-orange-100 text-orange-800',
  teal: 'bg-teal-100 text-teal-700',
}

/** Small colour swatch used in the settings editor. */
export const OPTION_COLOR_SWATCHES: Record<OptionColor, string> = {
  slate: 'bg-slate-400',
  blue: 'bg-blue-500',
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  violet: 'bg-violet-500',
  cyan: 'bg-cyan-500',
  rose: 'bg-rose-500',
  orange: 'bg-orange-500',
  teal: 'bg-teal-500',
}

export const OPTION_FIELDS: {
  key: OptionFieldKey
  label: string
  card: ContactCard
  multiple: boolean
  entity: 'contact' | 'company'
}[] = [
  // These two describe the business, not the person, so they live on the
  // company record and are shared by every contact who works there.
  { key: 'specialty_market', label: 'Specialty market', card: 'details', multiple: true, entity: 'company' },
  { key: 'customer_type', label: 'Company type', card: 'details', multiple: true, entity: 'company' },
  { key: 'role_type', label: 'Role type', card: 'influence', multiple: true, entity: 'contact' },
  { key: 'priority', label: 'Priority', card: 'influence', multiple: false, entity: 'contact' },
  { key: 'credibility', label: 'Credibility', card: 'influence', multiple: false, entity: 'contact' },
]

export const OPTION_FIELD_LABELS = Object.fromEntries(
  OPTION_FIELDS.map((field) => [field.key, field.label]),
) as Record<OptionFieldKey, string>

// -----------------------------------------------------------------------------
// Links
// -----------------------------------------------------------------------------

/**
 * Only http(s) and mailto are allowed through. Anything else — `javascript:`
 * above all — is rejected rather than rendered, because these values end up in
 * href attributes.
 */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null

  // A bare domain or handle is the common case in a CRM; assume https.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

const SOCIAL_BASES: Record<string, string> = {
  linkedin: 'https://linkedin.com/company/',
  facebook: 'https://facebook.com/',
  instagram: 'https://instagram.com/',
  tiktok: 'https://tiktok.com/@',
  x_twitter: 'https://x.com/',
}

/** Accepts either a full URL or a bare handle, and returns something clickable. */
export function socialUrl(network: keyof typeof SOCIAL_BASES, value: string | null): string | null {
  if (!value?.trim()) return null
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) return safeUrl(trimmed)
  return safeUrl(SOCIAL_BASES[network] + trimmed.replace(/^@/, ''))
}

/** Strips the scheme and trailing slash so a link reads as a label. */
export function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

// -----------------------------------------------------------------------------
// Notes
// -----------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inline(text: string): string {
  return (
    text
      // Code first, so formatting inside a code span is left alone.
      .replace(/`([^`]+)`/g, '<code class="rounded bg-slate-100 px-1 py-0.5 text-[0.85em]">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
        const url = safeUrl(href)
        if (!url) return label
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="text-brand-700 underline">${label}</a>`
      })
  )
}

/**
 * Renders the small markdown subset used by contact notes.
 *
 * Notes are stored as markdown and escaped *before* any formatting is applied,
 * so a note can never introduce markup of its own. That is the reason the
 * column holds markdown rather than HTML: storing HTML would mean either
 * trusting whatever was typed or maintaining a sanitiser.
 */
export function renderMarkdown(source: string | null | undefined): string {
  if (!source?.trim()) return ''

  const lines = escapeHtml(source).split(/\r?\n/)
  const html: string[] = []
  let list: 'ul' | 'ol' | null = null

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`)
      list = null
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed) {
      closeList()
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (heading) {
      closeList()
      const level = heading[1].length
      const size = level === 1 ? 'text-base' : level === 2 ? 'text-sm' : 'text-xs'
      html.push(`<p class="${size} font-semibold text-slate-900">${inline(heading[2])}</p>`)
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet) {
      if (list !== 'ul') {
        closeList()
        html.push('<ul class="list-disc space-y-0.5 pl-5">')
        list = 'ul'
      }
      html.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed)
    if (numbered) {
      if (list !== 'ol') {
        closeList()
        html.push('<ol class="list-decimal space-y-0.5 pl-5">')
        list = 'ol'
      }
      html.push(`<li>${inline(numbered[1])}</li>`)
      continue
    }

    closeList()
    html.push(`<p>${inline(trimmed)}</p>`)
  }

  closeList()
  return html.join('')
}

/** Days until the next occurrence of a birthday, or null if none is set. */
export function daysUntilBirthday(birthday: string | null | undefined, today = new Date()): number | null {
  if (!birthday) return null

  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthday)
  if (!parts) return null

  const month = Number(parts[2]) - 1
  const day = Number(parts[3])

  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  let next = new Date(start.getFullYear(), month, day)
  if (next < start) next = new Date(start.getFullYear() + 1, month, day)

  return Math.round((next.getTime() - start.getTime()) / 86_400_000)
}


/**
 * Everything that has an option list: the five built-in fields plus any custom
 * select or multi-select an organization has defined. Settings renders one list
 * from this, so there is a single place to manage option values and colours.
 */
export type OptionOwner = {
  key: string
  label: string
  entity: 'contact' | 'company'
  multiple: boolean
  builtIn: boolean
  /** Where the field appears on the record. */
  card: ContactCard
}

export function optionOwners(
  customFields: { key: string; label: string; entity_type: string; field_type: string; card: ContactCard }[],
): OptionOwner[] {
  const builtIn: OptionOwner[] = OPTION_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    entity: field.entity,
    multiple: field.multiple,
    builtIn: true,
    card: field.card,
  }))

  const custom: OptionOwner[] = customFields
    .filter((field) => field.field_type === 'select' || field.field_type === 'multiselect')
    .map((field) => ({
      key: field.key,
      label: field.label,
      entity: field.entity_type === 'company' ? 'company' : 'contact',
      multiple: field.field_type === 'multiselect',
      builtIn: false,
      card: field.card,
    }))

  return [...builtIn, ...custom]
}

/** Options for one field, in display order. */
export function optionsForField(
  options: { entity_type: string; field_key: string }[],
  entity: string,
  key: string,
) {
  return options.filter((option) => option.entity_type === entity && option.field_key === key)
}


/**
 * Roles as an admin sees them. 'regular' keeps its database name — renaming the
 * enum value would rewrite every user row for a label change.
 */
export const USER_ROLES: { value: string; label: string; description: string }[] = [
  { value: 'admin', label: 'Administrator', description: 'Everything, including settings, users and deleted records' },
  { value: 'manager', label: 'Manager', description: 'Every record in the organization; delete, import, export, assign' },
  { value: 'sales_director', label: 'Sales director', description: 'Own records plus unassigned; delete, import, export, assign' },
  { value: 'regular', label: 'Sales rep', description: 'Only their own records; create, edit and delete' },
  { value: 'readonly', label: 'Read-only', description: 'Can look, cannot change anything' },
]

export const USER_ROLE_LABELS = Object.fromEntries(
  USER_ROLES.map((role) => [role.value, role.label]),
) as Record<string, string>
