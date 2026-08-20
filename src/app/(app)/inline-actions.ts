'use server'

import { revalidatePath } from 'next/cache'

import { requireSession } from '@/lib/tenancy'
import { bulkFieldsFor, validateBulkChange } from '@/lib/bulk-edit'
import type { CustomFieldDefinitionRow, FieldOptionRow } from '@/lib/database.types'

export interface InlineState {
  ok?: boolean
  error?: string
}

/**
 * Changes one field on one record, from the list, without opening it.
 *
 * The same job `bulkUpdate` does, with the selection being a single row — and
 * deliberately the same route into the database. `bulk_update_records` runs as
 * the caller, so the row-level policies decide whether the change lands, and
 * the field name is checked against a whitelist inside the database rather
 * than trusted from the browser. A second write path with its own idea of
 * which columns may be edited is exactly how the two would drift apart.
 *
 * That whitelist is also what decides which cells the list offers to edit at
 * all: the select-shaped fields that say where a record sits in the business.
 * A name or an email address is not edited forty at a time and is not edited
 * from a list either — those still open the record, where the form can
 * validate them properly.
 *
 * An empty `values` means clear. The database is asked to remove the value
 * rather than to set an empty string, which for a custom field is the
 * difference between the key going away and it holding "".
 */
export async function updateCell(input: {
  entity: 'contact' | 'company'
  id: string
  field: string
  values: string[]
}): Promise<InlineState> {
  const context = await requireSession()

  const entity = input.entity === 'company' ? 'company' : 'contact'
  const listPath = entity === 'company' ? '/companies' : '/contacts'

  if (!context.canWrite) {
    return { error: 'Your role does not allow editing records.' }
  }

  if (!input.id) return { error: 'No record to change.' }

  /*
   * Ownership is a manager's decision, the same as it is on the record's own
   * form and in the bulk bar. A cell somebody can reach with one click must
   * not become the way around that.
   */
  if (input.field === 'owner_id' && !context.canManage) {
    return { error: 'Only a manager can reassign records.' }
  }

  const values = input.values.map(String).filter((value) => value !== '')
  const mode = values.length === 0 ? 'clear' : 'set'

  // The catalogue is rebuilt here rather than trusted from the browser: a
  // posted field name means nothing until it is found in the list this
  // organization actually has.
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

  const field = fields.find((candidate) => candidate.key === input.field)
  const problem = validateBulkChange(field, mode, values)
  if (problem) return { error: problem }

  const { data, error } = await context.supabase.rpc('bulk_update_records', {
    p_entity: entity,
    p_ids: [input.id],
    p_field: input.field,
    p_mode: mode,
    p_values: values,
  })

  if (error) return { error: error.message }

  /*
   * Zero rows means the policies refused this one, which is not an error the
   * database raises — it simply updates nothing. Saying so is the difference
   * between a cell that quietly springs back and one that explains itself.
   */
  if (Number(data ?? 0) === 0) {
    return { error: 'That record was not yours to edit.' }
  }

  revalidatePath(listPath)
  return { ok: true }
}
