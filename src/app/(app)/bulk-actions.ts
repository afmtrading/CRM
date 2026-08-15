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

/**
 * Sends a selection of contacts or companies to the recycle bin.
 *
 * Shares the selection form with bulkUpdate — the checkboxes are the same
 * checkboxes — and shares its shape of answer, so the bar above the list can
 * report either the same way.
 *
 * Everything that decides whether a particular record goes is in
 * `bulk_delete_records`. What is here is the capability gate, so the button is
 * not offered to somebody the database would refuse, and the sentence that
 * comes back.
 */
export async function bulkDelete(_prev: BulkState, formData: FormData): Promise<BulkState> {
  const context = await requireSession()

  const entity = formData.get('entity') === 'company' ? 'company' : 'contact'
  const listPath = entity === 'company' ? '/companies' : '/contacts'

  if (!context.canDelete) {
    return { error: 'Your role does not allow deleting records.' }
  }

  const ids = formData.getAll('ids').map(String).filter(Boolean)
  if (ids.length === 0) {
    return { error: 'Select some records first.' }
  }

  const { data, error } = await context.supabase.rpc('bulk_delete_records', {
    p_entity: entity,
    p_ids: ids,
  })

  if (error) return { error: error.message }

  const deleted = Number(data ?? 0)
  const noun = (count: number) =>
    entity === 'contact'
      ? count === 1
        ? 'contact'
        : 'contacts'
      : count === 1
        ? 'company'
        : 'companies'

  revalidatePath(listPath)
  revalidatePath('/settings/deleted')

  /*
   * The shortfall is reported rather than hidden. A rep who selects forty and
   * deletes thirty-one needs to know the other nine are still there — silence
   * would read as "all done" and the nine would be found again next week.
   */
  if (deleted === 0) {
    return { error: `Nothing was deleted — none of those ${noun(2)} were yours to delete.` }
  }

  if (deleted < ids.length) {
    return {
      ok: `${deleted} of ${ids.length} ${noun(ids.length)} deleted. The rest were not yours to delete.`,
    }
  }

  return { ok: `${deleted} ${noun(deleted)} moved to the recycle bin.` }
}
