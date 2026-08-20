import type {
  ContactCard,
  DealStatus,
  FieldOptionRow,
  ImportStatus,
  LifecycleStage,
  OptionColor,
  OptionFieldKey,
} from '@/lib/database.types'

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
/*
 * Appended rather than inserted: the detail and form pages reach for these by
 * index, so an entry added in the middle would silently retitle three cards.
 */
export const COMPANY_CARDS: { key: ContactCard; label: string; description: string }[] = [
  { key: 'details', label: 'Company info', description: 'Where to find the business and who owns it here' },
  { key: 'additional', label: 'Additional info', description: 'Ownership and notes' },
  { key: 'digital', label: 'Digital', description: 'Website and social profiles' },
  {
    key: 'rating',
    label: 'Company Rating',
    description: 'What kind of business it is — market, type, stock, reach and size',
  },
]

/**
 * A product's cards. 'pricing' exists nowhere else — what a thing costs has no
 * counterpart on a person or a business.
 */
export const PRODUCT_CARDS: { key: ContactCard; label: string; description: string }[] = [
  { key: 'details', label: 'Product details', description: '' },
  { key: 'pricing', label: 'Pricing', description: 'What it sells for and what it costs' },
  { key: 'additional', label: 'Additional info', description: 'Description and anything else' },
]

/**
 * A deal's cards. Two, because a deal record has two places a field can go: the
 * Details card beside the money and the dates, and everything else.
 */
export const DEAL_CARDS: { key: ContactCard; label: string; description: string }[] = [
  { key: 'details', label: 'Details', description: 'Beside the stage, value and dates' },
  { key: 'additional', label: 'Additional info', description: 'Anything else the desk tracks' },
]

export const DEAL_CARD_LABELS = Object.fromEntries(
  DEAL_CARDS.map((card) => [card.key, card.label]),
) as Record<ContactCard, string>

export const PRODUCT_CARD_LABELS = Object.fromEntries(
  PRODUCT_CARDS.map((card) => [card.key, card.label]),
) as Record<ContactCard, string>

/**
 * Every card a custom field can be assigned to, named so an admin can tell
 * which records offer it. One flat list rather than a per-record one: the card
 * picker in settings is a plain form, and a dependent dropdown would mean
 * shipping JavaScript for a choice made once.
 */
export const ALL_CARDS: { key: ContactCard; label: string }[] = [
  { key: 'details', label: 'Details' },
  { key: 'influence', label: 'Influence — contacts' },
  { key: 'rating', label: 'Company Rating — companies' },
  { key: 'pricing', label: 'Pricing — products' },
  { key: 'digital', label: 'Digital — contacts and companies' },
  { key: 'additional', label: 'Additional info' },
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
  if (entity === 'company') return COMPANY_CARD_LABELS[card] ?? CONTACT_CARD_LABELS[card] ?? card
  if (entity === 'product') return PRODUCT_CARD_LABELS[card] ?? CONTACT_CARD_LABELS[card] ?? card
  if (entity === 'deal') return DEAL_CARD_LABELS[card] ?? CONTACT_CARD_LABELS[card] ?? card
  return CONTACT_CARD_LABELS[card] ?? card
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

/** Records that can carry organization-defined fields and option lists. */
export type OptionEntity = 'contact' | 'company' | 'product' | 'deal'

export const OPTION_ENTITIES: { value: OptionEntity; label: string }[] = [
  { value: 'contact', label: 'Contact' },
  { value: 'company', label: 'Company' },
  { value: 'product', label: 'Product' },
  // A deal was absent here until it had somewhere to render a field. It has
  // two cards now, so an admin can define one.
  { value: 'deal', label: 'Deal' },
]

export const OPTION_FIELDS: {
  key: OptionFieldKey
  label: string
  card: ContactCard
  multiple: boolean
  entity: OptionEntity
}[] = [
  // These two describe the business, not the person, so they live on the
  // company record and are shared by every contact who works there.
  // The column keeps its original name; only what people read changed.
  { key: 'specialty_market', label: 'Merchandise', card: 'rating', multiple: true, entity: 'company' },
  /*
   * What condition the goods arrive in, which is a different question from what
   * category they are. A buyer of medical overstock and a buyer of medical
   * customer returns are not the same call, and one list holding both values
   * cannot tell them apart.
   */
  { key: 'stock_type', label: 'Stock type', card: 'rating', multiple: true, entity: 'company' },
  { key: 'customer_type', label: 'Company type', card: 'rating', multiple: true, entity: 'company' },
  /*
   * Its own list rather than the contacts' one, seeded to match it. Every other
   * select field here is scoped to an entity and Settings → Fields is grouped
   * that way — and it is the truer model besides: a Critical account can have a
   * Standard person at it, and one list would make those the same statement.
   */
  { key: 'priority', label: 'Priority', card: 'rating', multiple: false, entity: 'company' },
  /*
   * Where a selling account stands with the platform. On the company entity
   * because a marketplace *is* a company — the profile that makes it one holds
   * the value, and this list is what may go in it.
   */
  {
    key: 'marketplace_account_status',
    label: 'Marketplace account status',
    card: 'rating',
    multiple: false,
    entity: 'company',
  },
  /*
   * The rest of what tells one channel from another. All on the company entity,
   * because a marketplace is a company — there is no separate entity to hang
   * them off, and inventing one would give every company a list that applies to
   * some of them.
   */
  { key: 'marketplace_type', label: 'Marketplace type', card: 'rating', multiple: true, entity: 'company' },
  { key: 'marketplace_fulfilment', label: 'Marketplace fulfilment', card: 'rating', multiple: true, entity: 'company' },
  { key: 'marketplace_payment', label: 'Marketplace payment', card: 'rating', multiple: false, entity: 'company' },
  { key: 'marketplace_selling_cost', label: 'Marketplace selling cost', card: 'rating', multiple: false, entity: 'company' },
  { key: 'marketplace_audience', label: 'Marketplace audience', card: 'rating', multiple: true, entity: 'company' },
  { key: 'marketplace_inventory_type', label: 'Marketplace inventory type', card: 'rating', multiple: true, entity: 'company' },
  { key: 'role_type', label: 'Role type', card: 'influence', multiple: true, entity: 'contact' },
  { key: 'priority', label: 'Priority', card: 'influence', multiple: false, entity: 'contact' },
  { key: 'credibility', label: 'Credibility', card: 'influence', multiple: false, entity: 'contact' },
  // Seeded with nothing on purpose: a catalogue's categories are the
  // organization's own vocabulary, not one this app can guess.
  { key: 'product_category', label: 'Product category', card: 'details', multiple: false, entity: 'product' },
  // Type, condition and status started life as check constraints. They are the
  // organization's vocabulary after all — "Reserved" and "In Transit" are real
  // states nobody should need a deployment to add.
  { key: 'product_type', label: 'Product type', card: 'details', multiple: false, entity: 'product' },
  { key: 'product_condition', label: 'Condition', card: 'details', multiple: false, entity: 'product' },
  { key: 'product_status', label: 'Product status', card: 'details', multiple: false, entity: 'product' },
  // The same question a contact and a company are asked, asked of a line.
  { key: 'priority', label: 'Priority', card: 'details', multiple: false, entity: 'product' },
  // Why a deal was lost. An organization's own words: "Price" and "Timing" are
  // a starting point, not a taxonomy this app is asserting.
  { key: 'loss_reason', label: 'Loss reason', card: 'details', multiple: false, entity: 'deal' },
]

/**
 * Where each list's chosen values actually land.
 *
 * OPTION_FIELDS says a list exists and who it belongs to. This says which
 * column holds what somebody picked from it, which is a different fact and not
 * a derivable one: a product's category is stored in `category` under the key
 * product_category, its status in `status` under product_status, and every
 * marketplace list drops the prefix its key carries — marketplace_fulfilment
 * into `fulfilment`, marketplace_account_status into `account_status`.
 *
 * Written down because the data-integrity check has to join the two, and until
 * it was written down the only statements of it were a JSX attribute sitting
 * next to an optionsFor() call and a lookup keyed by filter path. Neither is
 * reachable from SQL, so the check restated the pairing a third time and
 * nothing would have said if it drifted. tests/data-integrity-sql.test.ts now
 * holds the check to this list.
 *
 * `entity` is the field_options entity_type to match on, which is not always
 * the record the value sits on: a marketplace's lists are the company's,
 * because a marketplace is a company with a profile attached.
 */
export const OPTION_VALUE_COLUMNS: {
  entity: OptionEntity
  key: OptionFieldKey
  /** The table the value is stored on, as the check names it. */
  table: 'contacts' | 'companies' | 'marketplace_profiles' | 'products' | 'deals'
  column: string
  multiple: boolean
}[] = [
  { entity: 'contact', key: 'priority', table: 'contacts', column: 'priority', multiple: false },
  { entity: 'contact', key: 'credibility', table: 'contacts', column: 'credibility', multiple: false },
  { entity: 'contact', key: 'role_type', table: 'contacts', column: 'role_type', multiple: true },

  { entity: 'company', key: 'priority', table: 'companies', column: 'priority', multiple: false },
  { entity: 'company', key: 'customer_type', table: 'companies', column: 'customer_type', multiple: true },
  { entity: 'company', key: 'specialty_market', table: 'companies', column: 'specialty_market', multiple: true },
  { entity: 'company', key: 'stock_type', table: 'companies', column: 'stock_type', multiple: true },

  // The prefix is the key's, not the column's. Every one of these differs.
  { entity: 'company', key: 'marketplace_type', table: 'marketplace_profiles', column: 'marketplace_type', multiple: true },
  { entity: 'company', key: 'marketplace_fulfilment', table: 'marketplace_profiles', column: 'fulfilment', multiple: true },
  { entity: 'company', key: 'marketplace_audience', table: 'marketplace_profiles', column: 'audience', multiple: true },
  { entity: 'company', key: 'marketplace_inventory_type', table: 'marketplace_profiles', column: 'inventory_type', multiple: true },
  { entity: 'company', key: 'marketplace_payment', table: 'marketplace_profiles', column: 'payment', multiple: false },
  { entity: 'company', key: 'marketplace_selling_cost', table: 'marketplace_profiles', column: 'selling_cost', multiple: false },
  { entity: 'company', key: 'marketplace_account_status', table: 'marketplace_profiles', column: 'account_status', multiple: false },

  // category and status are the two that do not read the way the key does.
  { entity: 'product', key: 'product_category', table: 'products', column: 'category', multiple: false },
  { entity: 'product', key: 'product_type', table: 'products', column: 'product_type', multiple: false },
  { entity: 'product', key: 'product_condition', table: 'products', column: 'product_condition', multiple: false },
  { entity: 'product', key: 'product_status', table: 'products', column: 'status', multiple: false },
  { entity: 'product', key: 'priority', table: 'products', column: 'priority', multiple: false },

  { entity: 'deal', key: 'loss_reason', table: 'deals', column: 'loss_reason', multiple: false },
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
  /*
   * @handle, like TikTok's. A channel can also be reached by /channel/UC… or an
   * old /c/ vanity path, and neither survives being prefixed — but both are
   * things people copy as a whole URL, and a whole URL is passed through
   * untouched below. So this base is for the one form that is typed bare.
   */
  youtube: 'https://youtube.com/@',
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
 * Everything that has an option list: the built-in fields plus any custom
 * select or multi-select an organization has defined. Settings renders one list
 * from this, so there is a single place to manage option values and colours.
 */
export type OptionOwner = {
  key: string
  label: string
  entity: OptionEntity
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
      entity:
        field.entity_type === 'company'
          ? 'company'
          : field.entity_type === 'product'
            ? 'product'
            : field.entity_type === 'deal'
              ? 'deal'
              : 'contact',
      multiple: field.field_type === 'multiselect',
      builtIn: false,
      card: field.card,
    }))

  return [...builtIn, ...custom]
}

/**
 * Options for one field, in display order.
 *
 * Both halves of the key, always. A field_key is only unique within a record
 * type — `priority` is a list on contacts, another on companies and another on
 * products — so filtering on the key alone draws every record type's list at
 * once. That is not hypothetical: it is what put each priority on the contact
 * form twice, the day companies were given a list of their own.
 *
 * Generic so a caller keeps the row type it passed in, which is what makes this
 * usable from the forms instead of each one writing the filter again.
 */
export function optionsForField<T extends { entity_type: string; field_key: string }>(
  options: T[],
  entity: string,
  key: string,
): T[] {
  return options.filter((option) => option.entity_type === entity && option.field_key === key)
}

/** One chip on a form: an option to pick, or a stored value that outlived its option. */
export type OptionChip = {
  id: string
  value: string
  color: OptionColor
  /**
   * True when nothing in the list accounts for this value. It still renders, and
   * still posts, so editing a record does not quietly discard it.
   */
  retired: boolean
}

/**
 * The chips a select or multi-select has to draw: every option in the list,
 * followed by any stored value the list no longer accounts for.
 *
 * The second half is the point. A chip group only ever rendered the options,
 * and a radio group only checked one on an exact match, so a record holding a
 * value an admin had since renamed — or an import had invented — checked
 * nothing at all. An unchecked radio group posts no entry, `Object.fromEntries`
 * leaves the key out, and the action writes its empty default over the top: the
 * value disappeared on the next save of an unrelated field, with nothing on
 * screen to say it had been there. Carrying it as a chip of its own means the
 * form round-trips what it cannot offer.
 *
 * Matching is case-insensitive, the same way the data-integrity check asks the
 * question. A value differing from its option only in case is that option, not
 * a second one, so it checks the real chip and converges on the list's spelling
 * when saved.
 */
export function chipsFor(
  options: Pick<FieldOptionRow, 'id' | 'value' | 'color'>[],
  stored: string | string[] | null | undefined,
): OptionChip[] {
  const chips: OptionChip[] = options.map((option) => ({
    id: option.id,
    value: option.value,
    color: option.color,
    retired: false,
  }))

  const listed = new Set(options.map((option) => option.value.toLowerCase()))
  const seen = new Set<string>()

  for (const raw of Array.isArray(stored) ? stored : [stored]) {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) continue

    const key = value.toLowerCase()
    if (listed.has(key) || seen.has(key)) continue
    seen.add(key)

    chips.push({ id: `retired:${value}`, value, color: 'slate', retired: true })
  }

  return chips
}

/** Whether a chip carries this stored value, ignoring case. See chipsFor. */
export function chipHolds(chip: OptionChip, stored: string | null | undefined): boolean {
  if (typeof stored !== 'string') return false
  const value = stored.trim()
  return value !== '' && chip.value.toLowerCase() === value.toLowerCase()
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

/*
 * The rest of the stored vocabularies, written the way a person reads them.
 *
 * Sales orders and invoices already had these, in lib/sales.ts beside the
 * status rules they belong to. Lifecycle stage, deal status and an import job's
 * state never got them, so they reached the screen as the column: a badge
 * reading "lead", another reading "won", a table cell reading "complete".
 *
 * Kept here rather than in the components that draw them, because a label is a
 * fact about the value and not about the badge — the same word has to come out
 * of a heading, a badge and a tooltip.
 */
export const LIFECYCLE_LABELS: Record<LifecycleStage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  customer: 'Customer',
  other: 'Other',
}

export const DEAL_STATUS_LABELS: Record<DealStatus, string> = {
  open: 'Open',
  won: 'Won',
  lost: 'Lost',
}

export const IMPORT_STATUS_LABELS: Record<ImportStatus, string> = {
  pending: 'Waiting',
  processing: 'Running',
  complete: 'Complete',
  failed: 'Failed',
}
