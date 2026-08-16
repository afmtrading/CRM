'use server'

import { revalidatePath } from 'next/cache'

import { requireSession } from '@/lib/tenancy'
import { columnCatalogue, normaliseSelection, type TableEntity } from '@/lib/table-columns'
import type { ColumnPreferenceRow, CustomFieldDefinitionRow } from '@/lib/database.types'

/**
 * Storing one person's column choice for one list.
 *
 * Shared by all three lists, because the only thing that differs is the word.
 * No permission gate beyond being signed in: a view preference is not a
 * capability, and requiring canWrite would mean a read-only user could not
 * arrange the screen they are allowed to read.
 *
 * The choice is validated against the catalogue rather than trusted. A posted
 * key that names no column would be stored, resolveColumns would drop it on the
 * way out, and the picker would then show a preference that silently does
 * nothing — so it is refused here instead.
 */

const PATHS: Record<TableEntity, string> = {
  contact: '/contacts',
  company: '/companies',
  product: '/products',
  marketplace: '/marketplaces',
}

function isEntity(value: string): value is TableEntity {
  return value in PATHS
}

export async function saveColumns(entity: string, columns: string[]): Promise<void> {
  const context = await requireSession()

  if (!isEntity(entity)) throw new Error(`There is no ${entity} list`)

  /*
   * The catalogue is rebuilt from this organization's custom fields rather than
   * accepted from the browser, so a key can only be stored if this organization
   * actually has a column by that name.
   */
  /*
   * A marketplace is a company, so it inherits the company's custom fields —
   * there is no 'marketplace' entity_type to define one against, and inventing
   * one would mean a field that exists on half the companies.
   */
  const { data: customFields } = await context.supabase
    .from('custom_field_definitions')
    .select('*')
    .eq('organization_id', context.organizationId)
    .eq('entity_type', entity === 'marketplace' ? 'company' : entity)

  const catalogue = columnCatalogue(entity, (customFields ?? []) as CustomFieldDefinitionRow[])
  const wanted = normaliseSelection(entity, columns, catalogue)

  const { error } = await context.supabase.rpc('save_column_preference', {
    p_entity: entity,
    p_columns: wanted,
  })

  if (error) throw new Error(error.message)
  revalidatePath(PATHS[entity])
}

export async function resetColumns(entity: string): Promise<void> {
  const context = await requireSession()

  if (!isEntity(entity)) throw new Error(`There is no ${entity} list`)

  const { error } = await context.supabase.rpc('reset_column_preference', { p_entity: entity })
  if (error) throw new Error(error.message)

  revalidatePath(PATHS[entity])
}

/** The keys this person has chosen for a list, or null if they never have. */
export async function readColumns(entity: TableEntity): Promise<string[] | null> {
  const context = await requireSession()

  const { data } = await context.supabase
    .from('column_preferences')
    .select('columns')
    .eq('user_id', context.user.id)
    .eq('entity_type', entity)
    .maybeSingle()

  const columns = (data as Pick<ColumnPreferenceRow, 'columns'> | null)?.columns
  return columns && columns.length > 0 ? columns : null
}
