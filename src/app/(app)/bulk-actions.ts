'use server'

import { revalidatePath } from 'next/cache'

import { requireSession } from '@/lib/tenancy'
import { bulkFieldsFor, bulkResultMessage, validateBulkChange } from '@/lib/bulk-edit'
import type { CustomFieldDefinitionRow, FieldOptionRow } from '@/lib/database.types'

export interface BulkState {
  ok?: string
  error?: string
}

/**
 * Changes one field across a selection of contacts or companies.
 *
 * Shared by both lists because the only difference between them is the word
 * "contact" — the field catalogue, the permission rules and the database
 * function are all keyed on the entity.
 *
 * Almost none of the safety lives here. `bulk_update_records` runs as the
 * caller, so the row-level policies decide which of the selected records the
 * change actually reaches, and the field name is checked against a whitelist
 * inside the database rather than trusted from this form. What this function
 * adds is a readable refusal instead of a raised exception, and the count of
 * what was skipped.
 */
export async function bulkUpdate(_prev: BulkState, formData: FormData): Promise<BulkState> {
  const context = await requireSession()

  const entity = formData.get('entity') === 'company' ? 'company' : 'contact'
  const listPath = entity === 'company' ? '/companies' : '/contacts'

  if (!context.canWrite) {
    return { error: 'Your role does not allow editing records.' }
  }

  const ids = formData.getAll('ids').map(String).filter(Boolean)
  if (ids.length === 0) {
    return { error: 'Select some records first.' }
  }

  const key = String(formData.get('field') ?? '')
  const mode = String(formData.get('mode') ?? 'set')
  const values = formData.getAll('values').map(String).filter((value) => value !== '')

  /*
   * Ownership is a manager's decision, the same as it is on a single record —
   * see updateContact, where a rep's form does not render the field at all.
   * Bulk editing must not become the way around that.
   */
  if (key === 'owner_id' && !context.canManage) {
    return { error: 'Only a manager can reassign records.' }
  }

  // The catalogue is rebuilt here rather than trusted from the form: a posted
  // field name means nothing until it is found in the list this organization
  // actually has.
  const [{ data: customFields }, { data: fieldOptions }] = await Promise.all([
    context.supabase
      .from('custom_field_definitions')
      .select('*')
      .eq('organization_id', context.organization.id)
      .eq('entity_type', entity),
    context.supabase
      .from('field_options')
      .select('*')
      .eq('organization_id', context.organization.id)
      .eq('entity_type', entity),
  ])

  const fields = bulkFieldsFor(entity, {
    // Labels do not matter for validation, and fetching users and companies
    // again just to build them would be two queries for nothing.
    owners: [],
    companies: [],
    customFields: (customFields ?? []) as CustomFieldDefinitionRow[],
    fieldOptions: (fieldOptions ?? []) as FieldOptionRow[],
  })

  const field = fields.find((candidate) => candidate.key === key)
  const problem = validateBulkChange(field, mode, values)
  if (problem) return { error: problem }

  const { data, error } = await context.supabase.rpc('bulk_update_records', {
    p_entity: entity,
    p_ids: ids,
    p_field: key,
    p_mode: mode,
    p_values: mode === 'clear' ? [] : values,
  })

  if (error) return { error: error.message }

  revalidatePath(listPath)
  return { ok: bulkResultMessage(Number(data ?? 0), ids.length, entity) }
}
