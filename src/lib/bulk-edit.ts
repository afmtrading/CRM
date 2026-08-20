import type { CustomFieldDefinitionRow, FieldOptionRow } from '@/lib/database.types'

/**
 * Which fields a list can change without opening the record, and how.
 *
 * One catalogue, two readers. The bulk bar asks "what may be set across forty
 * records at once"; an editable cell asks "what may be set on this one". Most
 * fields answer both, some answer only one, and `where` is what says so — a
 * single list rather than two that mirror each other and drift.
 *
 * All of it mirrors the whitelist inside `bulk_update_records`, which is the
 * thing that actually enforces it: a field added here and not there is refused
 * rather than written. That is the price of a picker that knows the labels and
 * a function that trusts nothing.
 *
 * Deliberately not every column, at either altitude. An email address is worth
 * correcting on one row and is nonsense across forty; a name is not offered at
 * all, because a record is recognised by it and a table cell is a bad place to
 * mistype one; a lead score is derived by the scoring rules and would be
 * overwritten by them.
 */

export type BulkEntity = 'contact' | 'company' | 'product'

export type BulkMode = 'set' | 'add' | 'remove' | 'clear'

/**
 * What kind of value a field holds, which decides both what the cell offers
 * and what counts as valid.
 *
 * 'select' is anything with a vocabulary behind it — the presence of options.
 * The rest are typed by hand, and each is checked differently: an address that
 * is not an address is worse than no address, and a price that is not a number
 * would reach the database as a cast error rather than a sentence.
 */
export type FieldKind = 'select' | 'text' | 'email' | 'phone' | 'number'

/** Where a field may be changed from: the bulk bar, a cell, or both. */
export type FieldWhere = 'both' | 'bulk' | 'inline'

export const BULK_MODE_LABELS: Record<BulkMode, string> = {
  set: 'Set to',
  add: 'Add',
  remove: 'Remove',
  clear: 'Clear',
}

export interface BulkField {
  key: string
  label: string
  /** Whether the field holds several values, which is what makes add and remove meaningful. */
  multiple: boolean
  /** What may be chosen. Absent means the value is typed rather than picked. */
  options?: { value: string; label: string }[]
  modes: BulkMode[]
  /** How the value is entered and checked. Defaults to 'select' where there are options. */
  kind?: FieldKind
  /** Defaults to 'both'. */
  where?: FieldWhere
}

/** The kind a field is, once the default has been worked out. */
export function fieldKind(field: BulkField): FieldKind {
  return field.kind ?? (field.options ? 'select' : 'text')
}

/** A single-value field: set it, or empty it. */
const SINGLE: BulkMode[] = ['set', 'clear']
/** A list: replace it wholesale, amend it, or empty it. */
const LIST: BulkMode[] = ['set', 'add', 'remove', 'clear']

const LIFECYCLE_STAGES = ['lead', 'qualified', 'customer', 'other']

export interface BulkFieldSources {
  /** Users who can own a record, already resolved to names. */
  owners: { value: string; label: string }[]
  /** Companies, for reassigning contacts. Only used by the contact list. */
  companies?: { value: string; label: string }[]
  customFields: CustomFieldDefinitionRow[]
  fieldOptions: FieldOptionRow[]
}

/** Everything either reader could offer, before it is filtered by `where`. */
function fieldsFor(entity: BulkEntity, sources: BulkFieldSources): BulkField[] {
  const { owners, companies = [], customFields, fieldOptions } = sources

  const optionsFor = (key: string) =>
    fieldOptions
      .filter((option) => option.entity_type === entity && option.field_key === key)
      .map((option) => ({ value: option.value, label: option.value }))

  const contactFields: BulkField[] = [
    { key: 'owner_id', label: 'Owner', multiple: false, options: owners, modes: SINGLE },
    { key: 'company_id', label: 'Company', multiple: false, options: companies, modes: SINGLE },
    {
      key: 'lifecycle_stage',
      label: 'Lifecycle stage',
      multiple: false,
      options: LIFECYCLE_STAGES.map((stage) => ({ value: stage, label: stage })),
      // No clear: the column is not nullable, and "no stage" is `lead`.
      modes: ['set'],
    },
    {
      key: 'priority',
      label: 'Priority',
      multiple: false,
      options: optionsFor('priority'),
      modes: SINGLE,
    },
    {
      key: 'credibility',
      label: 'Credibility',
      multiple: false,
      options: optionsFor('credibility'),
      modes: SINGLE,
    },
    {
      key: 'mailable_override',
      label: 'Can be emailed',
      multiple: false,
      options: [
        { value: 'true', label: 'Yes — send to them' },
        { value: 'false', label: 'No — never send' },
      ],
      // Clearing puts them back on the consent rules, which is a real third
      // state rather than an absence.
      modes: SINGLE,
    },
    {
      key: 'role_type',
      label: 'Role type',
      multiple: true,
      options: optionsFor('role_type'),
      modes: LIST,
    },
    /*
     * Typed rather than picked, and one row at a time. A title, an address and
     * a number are what somebody fixes while reading a list — the bounce, the
     * new job, the number that rings out — and none of them is a thing to set
     * across forty records, which is why they are `inline` rather than `both`.
     */
    {
      key: 'job_title',
      label: 'Job title',
      multiple: false,
      modes: SINGLE,
      kind: 'text',
      where: 'inline',
    },
    { key: 'email', label: 'Email', multiple: false, modes: SINGLE, kind: 'email', where: 'inline' },
    { key: 'phone', label: 'Phone', multiple: false, modes: SINGLE, kind: 'phone', where: 'inline' },
  ]

  const companyFields: BulkField[] = [
    { key: 'owner_id', label: 'Owner', multiple: false, options: owners, modes: SINGLE },
    {
      key: 'priority',
      label: 'Priority',
      multiple: false,
      // The company list, not the contacts' one — see 20260247000000.
      options: optionsFor('priority'),
      modes: SINGLE,
    },
    {
      key: 'specialty_market',
      label: 'Market',
      multiple: true,
      options: optionsFor('specialty_market'),
      modes: LIST,
    },
    {
      key: 'customer_type',
      label: 'Company type',
      multiple: true,
      options: optionsFor('customer_type'),
      modes: LIST,
    },
    {
      key: 'stock_type',
      label: 'Stock type',
      multiple: true,
      options: optionsFor('stock_type'),
      modes: LIST,
      where: 'inline',
    },
    { key: 'email', label: 'Email', multiple: false, modes: SINGLE, kind: 'email', where: 'inline' },
    { key: 'phone', label: 'Phone', multiple: false, modes: SINGLE, kind: 'phone', where: 'inline' },
  ]

  /*
   * A product's, all of them from a cell rather than the bar: there is no bulk
   * bar over the catalogue, and repricing forty lines to the same number is not
   * a thing anybody has asked for.
   *
   * Retail is `unit_price` and cost is `unit_cost` — the stored columns behind
   * what the list heads "Retail $" and "Cost $". Showroom and wholesale are
   * overrides: left empty they derive from retail, so clearing one is how a
   * price goes back to following the retail price rather than standing apart
   * from it. Neither of the first two may be cleared, because both columns are
   * NOT NULL and default to zero.
   */
  const productFields: BulkField[] = [
    {
      key: 'status',
      label: 'Status',
      multiple: false,
      options: optionsFor('product_status'),
      modes: SINGLE,
      where: 'inline',
    },
    {
      key: 'category',
      label: 'Category',
      multiple: false,
      options: optionsFor('product_category'),
      modes: SINGLE,
      where: 'inline',
    },
    {
      key: 'product_condition',
      label: 'Condition',
      multiple: false,
      options: optionsFor('product_condition'),
      modes: SINGLE,
      where: 'inline',
    },
    {
      key: 'priority',
      label: 'Priority',
      multiple: false,
      options: optionsFor('priority'),
      modes: SINGLE,
      where: 'inline',
    },
    { key: 'brand', label: 'Brand', multiple: false, modes: SINGLE, kind: 'text', where: 'inline' },
    { key: 'sku', label: 'SKU', multiple: false, modes: SINGLE, kind: 'text', where: 'inline' },
    {
      key: 'unit_price',
      label: 'Retail price',
      multiple: false,
      modes: ['set'],
      kind: 'number',
      where: 'inline',
    },
    {
      key: 'unit_cost',
      label: 'Cost',
      multiple: false,
      modes: ['set'],
      kind: 'number',
      where: 'inline',
    },
    {
      key: 'price_showroom',
      label: 'Showroom price',
      multiple: false,
      modes: SINGLE,
      kind: 'number',
      where: 'inline',
    },
    {
      key: 'price_wholesale',
      label: 'Wholesale price',
      multiple: false,
      modes: SINGLE,
      kind: 'number',
      where: 'inline',
    },
  ]

  const fields =
    entity === 'contact' ? contactFields : entity === 'company' ? companyFields : productFields

  /*
   * An organization's own fields come last, in the order an admin arranged
   * them. Only set and clear: amending a list nested inside the JSON document
   * is a great deal of SQL for a case nobody has asked for, so a multi-value
   * custom field is replaced wholesale.
   */
  const custom = customFields
    .filter((definition) => definition.entity_type === entity)
    .filter((definition) => definition.field_type !== 'boolean')
    .map<BulkField>((definition) => ({
      key: `custom_fields.${definition.key}`,
      label: definition.label,
      multiple: definition.field_type === 'multiselect',
      options:
        definition.field_type === 'select' || definition.field_type === 'multiselect'
          ? fieldOptions
              .filter(
                (option) =>
                  option.entity_type === entity && option.field_key === definition.key,
              )
              .map((option) => ({ value: option.value, label: option.value }))
          : undefined,
      modes: SINGLE,
    }))

  return [...fields, ...custom]
}

/** What the bulk bar above a list offers. */
export function bulkFieldsFor(entity: BulkEntity, sources: BulkFieldSources): BulkField[] {
  return fieldsFor(entity, sources).filter((field) => (field.where ?? 'both') !== 'inline')
}

/** What a cell in that list offers. */
export function inlineFieldsFor(entity: BulkEntity, sources: BulkFieldSources): BulkField[] {
  return fieldsFor(entity, sources).filter((field) => (field.where ?? 'both') !== 'bulk')
}

/**
 * Whether a request makes sense before it reaches the database.
 *
 * The database refuses anything it does not recognise, so this is not the
 * defence — it is what turns a refusal into a sentence somebody can act on.
 */
export function validateBulkChange(
  field: BulkField | undefined,
  mode: string,
  values: string[],
): string | null {
  if (!field) return 'Pick a field to change.'
  if (!field.modes.includes(mode as BulkMode)) {
    /*
     * "cannot be clear" is not a sentence, and clearing is the one a cell hits
     * — empty the box on a price that is NOT NULL and this is the answer. The
     * others keep the plain wording the bulk bar has always used.
     */
    return mode === 'clear'
      ? `${field.label} cannot be emptied.`
      : `${field.label} cannot be ${mode}.`
  }

  if (mode !== 'clear' && values.length === 0) {
    return field.options
      ? `Choose what to set ${field.label.toLowerCase()} to.`
      : `Enter a value for ${field.label.toLowerCase()}.`
  }

  // A single-value field given several would silently keep one of them; say so
  // instead, since which one it kept would be nobody's decision.
  if (!field.multiple && mode !== 'clear' && values.length > 1) {
    return `${field.label} holds one value, but several were chosen.`
  }

  /*
   * What was typed, checked before it is sent.
   *
   * The database would take any of these — a text column holds whatever fits —
   * so this is the only thing standing between a mistyped address and a record
   * that quietly cannot be emailed. Deliberately the same shapes the record's
   * own form enforces: a cell that accepts what the form rejects would make the
   * two screens disagree about the same field.
   */
  if (mode !== 'clear') {
    for (const value of values) {
      const problem = valueProblem(field, value)
      if (problem) return problem
    }
  }

  return null
}

/** The longest a typed value may be, matching the record forms' own limits. */
const MAX_LENGTH: Partial<Record<FieldKind, number>> = {
  text: 200,
  email: 200,
  phone: 60,
}

/*
 * Loose on purpose: something, an @, something with a dot in it. The strict
 * grammar for an address is famously unenforceable, and a pattern that rejects
 * a real address is worse than one that lets a typo through — the point is to
 * catch "acme.com" typed into an email box, not to adjudicate RFC 5322.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function valueProblem(field: BulkField, value: string): string | null {
  const kind = fieldKind(field)
  const limit = MAX_LENGTH[kind]

  if (limit && value.length > limit) {
    return `${field.label} is longer than ${limit} characters.`
  }

  if (kind === 'email' && !EMAIL.test(value)) {
    return `${value} is not an email address.`
  }

  if (kind === 'number') {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return `${field.label} has to be a number.`
    // Every numeric column this reaches is a price, and the database checks the
    // same thing — this is the readable half of that refusal.
    if (parsed < 0) return `${field.label} cannot be negative.`
  }

  return null
}

/** "12 contacts updated", and the awkward cases around it. */
export function bulkResultMessage(
  changed: number,
  selected: number,
  entity: 'contact' | 'company',
): string {
  const noun = (count: number) =>
    entity === 'contact'
      ? `${count} contact${count === 1 ? '' : 's'}`
      : `${count} compan${count === 1 ? 'y' : 'ies'}`

  if (changed === 0) return 'Nothing changed — you may not have access to those records.'
  if (changed < selected) {
    // Rows a colleague owns are skipped rather than refused, so the difference
    // has to be said out loud or it looks like the change half-failed.
    return `${noun(changed)} updated. ${selected - changed} skipped — not yours to edit.`
  }
  return `${noun(changed)} updated.`
}
