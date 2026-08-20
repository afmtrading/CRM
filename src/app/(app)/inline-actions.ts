'use server'

import { revalidatePath } from 'next/cache'

import { requireSession } from '@/lib/tenancy'
import { inlineFieldsFor, validateBulkChange, type BulkEntity } from '@/lib/bulk-edit'
import { syncTags, type TaggableEntity } from '@/lib/tags'
import type { CustomFieldDefinitionRow, FieldOptionRow } from '@/lib/database.types'

export interface InlineState {
  ok?: boolean
  error?: string
}

/** Where each list lives, for the revalidation that follows a save. */
const LIST_PATH: Record<BulkEntity, string> = {
  contact: '/contacts',
  company: '/companies',
  product: '/products',
}

/**
 * Turns a raised constraint into a sentence.
 *
 * Two of these can be hit from a cell now that a SKU and an address can be
 * typed into one, and Postgres says so in a way nobody should have to read.
 * Anything unrecognised is passed through rather than swallowed — a message
 * that says "something went wrong" is worse than a technical one.
 */
function readable(message: string): string {
  if (/products_org_sku_idx|duplicate key/i.test(message)) {
    return 'Another product already has that SKU.'
  }
  if (/violates not-null/i.test(message)) return 'That field cannot be left empty.'
  return message
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
 * What a cell may reach is `inlineFieldsFor`, which is the same catalogue the
 * bulk bar reads — one list, two halves of it. Everything in either half is in
 * the database's whitelist too; nothing else is offered anywhere.
 *
 * An empty `values` means clear. The database is asked to remove the value
 * rather than to set an empty string, which for a custom field is the
 * difference between the key going away and it holding "".
 */
export async function updateCell(input: {
  entity: BulkEntity
  id: string
  field: string
  values: string[]
}): Promise<InlineState> {
  const context = await requireSession()

  const entity = input.entity
  const listPath = LIST_PATH[entity]
  if (!listPath) return { error: 'That is not a list this can edit.' }

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

  /*
   * The catalogue is not one person's records — it is the desk's — and its
   * policy says so. Checked here as well so a rep reads a sentence rather than
   * watching a price spring back with "not yours to edit" under it.
   */
  if (entity === 'product' && !context.canManage) {
    return { error: 'Only a manager can change the catalogue.' }
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

  const fields = inlineFieldsFor(entity, {
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

  if (error) return { error: readable(error.message) }

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

/**
 * The tags on one record, from the list.
 *
 * Its own function because tags are its own shape: a join table rather than a
 * column, so `bulk_update_records` has nothing to write and the whitelist has
 * nothing to say about it. `syncTags` is the same call the record forms make —
 * delete what is there, insert what was chosen — and the join tables' policies
 * check both halves against the record and the organization.
 *
 * Products included. Repricing the catalogue takes a manager; putting a word
 * on a line does not, which is what each join table's policy already says.
 */
export async function updateCellTags(input: {
  entity: TaggableEntity
  id: string
  tagIds: string[]
}): Promise<InlineState> {
  const context = await requireSession()

  const listPath = LIST_PATH[input.entity]
  if (!listPath) return { error: 'That is not a list this can edit.' }

  if (!context.canWrite) {
    return { error: 'Your role does not allow editing records.' }
  }

  if (!input.id) return { error: 'No record to change.' }

  try {
    await syncTags(context, input.entity, input.id, input.tagIds.map(String).filter(Boolean))
  } catch (error) {
    return { error: readable(error instanceof Error ? error.message : 'That did not save.') }
  }

  revalidatePath(listPath)
  // Marketplaces are companies, and show the company's tags.
  if (input.entity === 'company') revalidatePath('/marketplaces')
  return { ok: true }
}
