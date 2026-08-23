import type { Json, LifecycleStage, MarketingFormRow } from '@/lib/database.types'

/**
 * Marketing forms, minus the database.
 *
 * The rules about what a question may be live in two places on purpose. The
 * trigger on marketing_forms is the one that decides — it is the only one both
 * the public renderer and the submit function sit behind. What is here is the
 * same rulebook said early, so somebody building a form is told "two questions
 * both fill the email address" while they are looking at the two questions,
 * rather than after a round trip that answers in the database's voice.
 *
 * If the two ever disagree, the database wins and the person sees a refusal
 * rather than a form that renders into the public and cannot be submitted.
 */

export type FormFieldType =
  | 'text'
  | 'email'
  | 'phone'
  | 'number'
  | 'textarea'
  | 'select'
  | 'checkbox'

export interface FormField {
  key: string
  label: string
  type: FormFieldType
  required: boolean
  /** Which contact column this answer fills, or '' to keep it on the submission. */
  maps_to: string
  placeholder?: string
  help?: string
  options?: string[]
}

export const FIELD_TYPES: { value: FormFieldType; label: string; hint: string }[] = [
  { value: 'text', label: 'Single line', hint: 'A name, a company, a reference' },
  { value: 'email', label: 'Email address', hint: 'Checked for an @ before it is accepted' },
  { value: 'phone', label: 'Phone number', hint: 'Opens the number pad on a phone' },
  { value: 'number', label: 'Number', hint: 'Quantities, budgets, pallet counts' },
  { value: 'textarea', label: 'Paragraph', hint: 'What are you looking for?' },
  { value: 'select', label: 'Choose one', hint: 'A fixed list you write below' },
  { value: 'checkbox', label: 'Tick box', hint: 'Yes or no. Not the consent box — that is set below.' },
]

/**
 * The columns a form may fill, and nothing else.
 *
 * Short by design, and the same list the trigger enforces. Everything absent
 * from it — owner, score, lifecycle, consent — is either decided by the form's
 * own settings or by a rule, because those are the fields whose value would be
 * decided by a stranger otherwise.
 */
export interface MappingTarget {
  value: string
  label: string
  hint?: string
}

export const MAPPING_TARGETS: MappingTarget[] = [
  { value: '', label: 'Keep on the submission only', hint: 'Recorded, but fills no field on the contact' },
  { value: 'full_name', label: 'Name (one field)', hint: 'Split on the first space' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'email', label: 'Email address' },
  { value: 'phone', label: 'Phone' },
  { value: 'job_title', label: 'Job title' },
  { value: 'company_name', label: 'Company', hint: 'Matched by name, or created if it is new' },
  { value: 'website', label: 'Website' },
  { value: 'notes', label: 'Notes' },
]

export const FORM_STATUS_LABELS: Record<MarketingFormRow['status'], string> = {
  draft: 'Draft',
  published: 'Live',
  closed: 'Closed',
}

export const FORM_STATUS_STYLES: Record<MarketingFormRow['status'], string> = {
  draft: 'bg-slate-100 text-slate-600',
  published: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-amber-100 text-amber-800',
}

export const CONSENT_BASIS_OPTIONS: {
  value: MarketingFormRow['consent_basis']
  label: string
  hint: string
}[] = [
  {
    value: 'express',
    label: 'Express — show a tick box',
    hint: 'Ticking it is what makes the consent express. Never pre-ticked, and the exact words are kept with every submission.',
  },
  {
    value: 'implied',
    label: 'Implied — the request itself',
    hint: 'For a quote or a sample request: submitting is the business relationship. Expires after two years, like any implied consent.',
  },
  {
    value: 'none',
    label: 'None — do not record consent',
    hint: 'For a support or careers form. They can still be replied to; they will not be added to a campaign.',
  },
]

export const LIFECYCLE_ON_CAPTURE: LifecycleStage[] = ['lead', 'qualified', 'other']

/** A name turned into something that can live in a URL. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}

/**
 * The address a new form gets offered.
 *
 * The suffix is not decoration. Slugs are unique across every organization —
 * /f/<slug> carries no tenant — so without one the first account to create
 * "contact-us" holds it against every other account on the installation. It is
 * a default and nothing more: the address can be edited to anything still free.
 */
export function suggestSlug(name: string, suffix: string): string {
  const base = slugify(name) || 'form'
  const tail = suffix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)
  return tail ? `${base}-${tail}` : base
}

/** A question key derived from its label, kept unique against the ones taken. */
export function fieldKey(label: string, taken: string[]): string {
  const base =
    slugify(label).replace(/-/g, '_').replace(/^[^a-z]+/, '').slice(0, 32) || 'question'

  if (!taken.includes(base)) return base

  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}_${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${base}_${Date.now().toString(36)}`
}

const FIELD_TYPE_VALUES = FIELD_TYPES.map((type) => type.value) as string[]

/** Reads the fields column back, dropping anything that is not a question. */
export function parseFields(value: Json | null | undefined): FormField[] {
  if (!Array.isArray(value)) return []

  const fields: FormField[] = []

  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as Record<string, Json | undefined>

    const key = typeof row.key === 'string' ? row.key : ''
    const label = typeof row.label === 'string' ? row.label : ''
    const type = typeof row.type === 'string' && FIELD_TYPE_VALUES.includes(row.type)
      ? (row.type as FormFieldType)
      : 'text'

    if (!key || !label) continue

    fields.push({
      key,
      label,
      type,
      required: row.required === true,
      maps_to: typeof row.maps_to === 'string' ? row.maps_to : '',
      placeholder: typeof row.placeholder === 'string' ? row.placeholder : '',
      help: typeof row.help === 'string' ? row.help : '',
      options: Array.isArray(row.options) ? row.options.filter((o): o is string => typeof o === 'string') : [],
    })
  }

  return fields
}

/**
 * Why this list of questions could not go live, or null if it could.
 *
 * Deliberately the publication rules rather than the saving rules: a
 * half-finished form is allowed to be saved, and telling somebody their draft
 * is wrong while they are still typing it is how a builder becomes unusable.
 */
export function whyNotPublishable(fields: FormField[]): string | null {
  if (fields.length === 0) return 'Add at least one question.'

  const seenKeys = new Set<string>()
  const seenTargets = new Set<string>()

  for (const field of fields) {
    if (!field.label.trim()) return 'Every question needs a label.'
    if (seenKeys.has(field.key)) return `Two questions share the key “${field.key}”.`
    seenKeys.add(field.key)

    if (field.type === 'select' && (field.options ?? []).length === 0) {
      return `“${field.label}” is a choose-one question with no options.`
    }

    if (field.maps_to) {
      if (seenTargets.has(field.maps_to)) {
        const target = MAPPING_TARGETS.find((t) => t.value === field.maps_to)
        return `Two questions both fill ${target?.label ?? field.maps_to}.`
      }
      seenTargets.add(field.maps_to)
    }
  }

  if (seenTargets.has('full_name') && (seenTargets.has('first_name') || seenTargets.has('last_name'))) {
    return 'Ask for a full name or for first and last names, not both.'
  }

  if (!seenTargets.has('email')) {
    return 'One question has to fill the email address — without it a submission cannot become a contact.'
  }

  return null
}

/** One submission's answers, as they were labelled on the day. */
export interface SubmittedAnswer {
  key: string
  label: string
  value: string
}

export function parseAnswers(value: Json | null | undefined): SubmittedAnswer[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const row = entry as Record<string, Json | undefined>
    const label = typeof row.label === 'string' ? row.label : ''
    const answer = typeof row.value === 'string' ? row.value : ''
    if (!label) return []
    return [{ key: typeof row.key === 'string' ? row.key : '', label, value: answer }]
  })
}

/** The public address of a form. */
export function formUrl(siteUrl: string, slug: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/f/${slug}`
}

/**
 * The snippet somebody pastes into their own website.
 *
 * An iframe rather than a script tag, and that is the whole design. A script
 * that injects markup inherits the host page's CSS and breaks differently on
 * every site it is pasted into; it needs CORS on the submit endpoint; and it
 * asks a customer to run our JavaScript on their page, which is a bigger favour
 * than it sounds. An iframe renders the page we already serve, styled the way
 * we already style it, and posts to its own origin.
 *
 * The height is fixed because a frame cannot measure itself across origins
 * without messaging back, and a form that resizes as you type is worse than one
 * that scrolls.
 */
export function embedSnippet(url: string, height = 640): string {
  return [
    `<iframe src="${url}"`,
    `  title="Contact form"`,
    `  width="100%" height="${height}"`,
    `  style="border:0;max-width:640px"`,
    `  loading="lazy"></iframe>`,
  ].join('\n')
}

/** The utm_* parameters worth keeping, in the order they are usually read. */
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const

export function readUtm(params: Record<string, string | string[] | undefined>): Record<string, string> {
  const utm: Record<string, string> = {}

  for (const key of UTM_KEYS) {
    const value = params[key]
    const single = Array.isArray(value) ? value[0] : value
    if (typeof single === 'string' && single.trim()) utm[key] = single.trim().slice(0, 200)
  }

  return utm
}
