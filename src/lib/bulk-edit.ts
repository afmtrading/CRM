import type { CustomFieldDefinitionRow, FieldOptionRow } from '@/lib/database.types'

/**
 * Which fields can be changed across many records at once, and how.
 *
 * This list mirrors the whitelist inside `bulk_update_records` — the database
 * is the one that enforces it, and a field added here without being added
 * there is refused rather than written. Two copies is the price of a picker
 * that knows the labels and a function that trusts nothing.
 *
 * Deliberately not every column. A name is not something anybody sets forty of
 * at once, and an email address certainly is not: these are the fields that say
 * where a record sits in the business rather than which record it is.
 */

export type BulkMode = 'set' | 'add' | 'remove' | 'clear'

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

export function bulkFieldsFor(
  entity: 'contact' | 'company',
  sources: BulkFieldSources,
): BulkField[] {
  const { owners, companies = [], customFields, fieldOptions } = sources

  const optionsFor = (key: string) =>
    fieldOptions
      .filter((option) => option.entity_type === entity && option.field_key === key)
      .map((option) => ({ value: option.value, label: option.value }))

  const fields: BulkField[] =
    entity === 'contact'
      ? [
          { key: 'owner_id', label: 'Owner', multiple: false, options: owners, modes: SINGLE },
          {
            key: 'company_id',
            label: 'Company',
            multiple: false,
            options: companies,
            modes: SINGLE,
          },
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
            // Clearing puts them back on the consent rules, which is a real
            // third state rather than an absence.
            modes: SINGLE,
          },
          {
            key: 'role_type',
            label: 'Role type',
            multiple: true,
            options: optionsFor('role_type'),
            modes: LIST,
          },
        ]
      : [
          { key: 'owner_id', label: 'Owner', multiple: false, options: owners, modes: SINGLE },
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
        ]

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
  if (!field.modes.includes(mode as BulkMode)) return `${field.label} cannot be ${mode}.`

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
