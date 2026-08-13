/**
 * Organization-defined fields, on the way in and on the way back out.
 *
 * A custom field posts as `custom.<key>` from CustomFieldInputs and is stored
 * in the record's `custom_fields` json. Both halves of that round trip live
 * here so the shape written by one record type is the shape read by every
 * other — this was three identical private copies in three actions files
 * before deals needed a fourth.
 */

import type { ContactCard, CustomFieldDefinitionRow } from '@/lib/database.types'

/** What a custom field can hold once it has been through a form. */
export type CustomFieldValue = string | string[]

/**
 * Reads `custom.*` inputs off a submitted form.
 *
 * Empty values are dropped rather than stored as empty strings: a field nobody
 * filled in should be absent, not present and blank, or every record grows a
 * key for every field an admin has ever defined.
 */
export function readCustomFields(formData: FormData): Record<string, CustomFieldValue> {
  const custom: Record<string, CustomFieldValue> = {}

  for (const key of new Set([...formData.keys()].filter((k) => k.startsWith('custom.')))) {
    const values = formData
      .getAll(key)
      .map(String)
      .map((value) => value.trim())
      .filter(Boolean)

    if (values.length === 0) continue

    // A multiselect posts the same key repeatedly; keep it an array so the
    // stored shape matches how the field is rendered back.
    custom[key.slice('custom.'.length)] = values.length > 1 ? values : values[0]
  }

  return custom
}

/** The definitions for one record type, in the order an admin arranged them. */
export function definitionsFor(
  definitions: CustomFieldDefinitionRow[],
  entity: string,
): CustomFieldDefinitionRow[] {
  return definitions
    .filter((definition) => definition.entity_type === entity)
    .sort((a, b) => a.order - b.order)
}

/** The definitions assigned to one card, for the form and the record page. */
export function definitionsOnCard(
  definitions: CustomFieldDefinitionRow[],
  entity: string,
  card: ContactCard,
): CustomFieldDefinitionRow[] {
  return definitionsFor(definitions, entity).filter((definition) => definition.card === card)
}

/**
 * A stored value as text for display.
 *
 * A multiselect is a list and reads as one; anything absent reads as nothing at
 * all rather than "undefined".
 */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(String).join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

/** Whether a record has anything at all to show for these fields. */
export function hasAnyValue(
  definitions: CustomFieldDefinitionRow[],
  values: Record<string, unknown>,
): boolean {
  return definitions.some((definition) => displayValue(values[definition.key]) !== '')
}
