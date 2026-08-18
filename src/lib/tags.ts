import type { SessionContext, TenantTable } from '@/lib/tenancy'

/**
 * Tagging, in one place.
 *
 * Three records can carry tags and they all carry the same ones — a tag is the
 * organization's own word for something that cuts across record types ("Q4
 * push", "EU only"), and it is worth nothing if the word means one thing on a
 * contact and another on a line. Only the join table and its column differ, so
 * that is all this module holds.
 *
 * The tenancy import is type-only on purpose. `scoped()` lives behind
 * `server-only`, and reaching for it here would make even the pure form-reading
 * half of this file unloadable in a test. Everything it would have added is one
 * property of the context, so it is spelled out below instead.
 */

export type TaggableEntity = 'contact' | 'company' | 'product'

/** The join table each record's tags live in, and the column pointing back. */
const JOINS: Record<TaggableEntity, { table: TenantTable; column: string }> = {
  contact: { table: 'contact_tags', column: 'contact_id' },
  company: { table: 'company_tags', column: 'company_id' },
  product: { table: 'product_tags', column: 'product_id' },
}

/**
 * The tags a form is posting.
 *
 * A form that carries the control but has nothing ticked posts no `tag_ids` at
 * all, which is indistinguishable from a form that never had the control — so
 * the create and edit forms send a marker field alongside it. Without that
 * marker this returns null, meaning "said nothing about tags", and the caller
 * leaves whatever is stored alone. That is the difference between an untagged
 * save and a save from a screen that does not ask about tags, and getting it
 * wrong would quietly strip a record's tags on every edit.
 */
export function tagIdsFrom(formData: FormData): string[] | null {
  if (!formData.has('tags_present')) return null
  return formData.getAll('tag_ids').map(String).filter(Boolean)
}

/**
 * Makes a record's tags exactly `tagIds`.
 *
 * Delete-then-insert rather than a diff: the set is small, the form posts the
 * whole answer rather than a change to it, and a diff would be three round
 * trips to save two. Both halves are scoped to the organization, and a trigger
 * on each join table derives organization_id from the record itself — so the
 * value sent here is checked against the record rather than trusted.
 */
export async function syncTags(
  context: SessionContext,
  entity: TaggableEntity,
  recordId: string,
  tagIds: string[],
): Promise<void> {
  const { table, column } = JOINS[entity]

  await context.supabase
    .from(table)
    .delete()
    .eq('organization_id', context.organizationId)
    .eq(column, recordId)

  if (tagIds.length === 0) return

  await context.supabase.from(table).insert(
    tagIds.map((tagId) => ({
      organization_id: context.organizationId,
      [column]: recordId,
      tag_id: tagId,
    })),
  )
}
