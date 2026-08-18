'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanBulk, assertCanManage, assertCanWrite, requireSession, scoped } from '@/lib/tenancy'
// Aliased: this file already has an ActionState of its own, for the record
// forms, whose shape is different.
import type { ActionState as ButtonState } from '@/components/action-form'
import { readCustomFields } from '@/lib/custom-fields'
import { syncTags, tagIdsFrom } from '@/lib/tags'
import { safeUrl } from '@/lib/field-options'
import { likeLiteral } from '@/lib/sql'
import type { ContactLink, ContactRow, LifecycleStage } from '@/lib/database.types'

const lifecycleStages = ['lead', 'qualified', 'customer', 'other'] as const

const contactSchema = z.object({
  first_name: z.string().trim().max(120).default(''),
  last_name: z.string().trim().max(120).default(''),
  email: z.string().trim().email().or(z.literal('')).default(''),
  phone: z.string().trim().max(60).default(''),
  company_id: z.string().uuid().or(z.literal('')).default(''),
  owner_id: z.string().uuid().or(z.literal('')).default(''),
  lifecycle_stage: z.enum(lifecycleStages).default('lead'),
  source: z.string().trim().max(120).default(''),
  job_title: z.string().trim().max(160).default(''),
  office_phone: z.string().trim().max(60).default(''),
  priority: z.string().trim().max(60).default(''),
  credibility: z.string().trim().max(60).default(''),
  // A date input posts '' when cleared, which is not a valid date.
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).default(''),
  notes: z.string().max(20_000).default(''),
  website: z.string().trim().max(300).default(''),
  facebook: z.string().trim().max(300).default(''),
  instagram: z.string().trim().max(300).default(''),
  tiktok: z.string().trim().max(300).default(''),
  x_twitter: z.string().trim().max(300).default(''),
  linkedin: z.string().trim().max(300).default(''),
})

/**
 * Named links from the Digital card. Anything whose URL will not survive
 * safeUrl() is dropped rather than stored: these end up in href attributes, so
 * a `javascript:` value must never reach the database in the first place.
 */
function readLinks(formData: FormData): ContactLink[] {
  const raw = formData.get('links')
  if (typeof raw !== 'string' || !raw.trim()) return []

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((entry): entry is ContactLink => Boolean(entry) && typeof entry.url === 'string')
      .map((entry) => ({ label: String(entry.label ?? '').trim().slice(0, 120), url: entry.url.trim() }))
      .filter((entry) => safeUrl(entry.url) !== null)
      .slice(0, 25)
  } catch {
    return []
  }
}

/** Multi-select values arrive as repeated form entries. */
function readList(formData: FormData, name: string): string[] {
  return [...new Set(formData.getAll(name).map(String).map((v) => v.trim()).filter(Boolean))]
}

/**
 * Resolves the company picker to an id.
 *
 * The picker posts either an existing `company_id` or a `new_company_name` to
 * create, so someone entering a contact for a company the CRM has never seen is
 * not sent away to create it first. An existing company with the same name is
 * reused rather than duplicated — the search is case-insensitive, but two
 * people typing "Acme" and "ACME" a week apart should still land on one record.
 */
async function resolveCompanyId(
  context: Awaited<ReturnType<typeof requireSession>>,
  companyId: string,
  formData: FormData,
): Promise<{ id: string | null; error?: string }> {
  if (companyId) return { id: companyId }

  const name = String(formData.get('new_company_name') ?? '').trim()
  if (!name) return { id: null }

  const { data: existing } = await scoped(context, 'companies')
    .select('id')
    .ilike('name', likeLiteral(name))
    .is('deleted_at', null)
    .limit(1)

  const match = ((existing ?? []) as { id: string }[])[0]
  if (match) return { id: match.id }

  const { data, error } = await scoped(context, 'companies')
    .insert({ name })
    .select('id')
    .single()

  if (error) return { id: null, error: error.message }
  return { id: data.id }
}

/** The columns shared by create and update. */
function contactColumns(input: z.infer<typeof contactSchema>, formData: FormData) {
  return {
    first_name: input.first_name,
    last_name: input.last_name,
    email: input.email || null,
    phone: input.phone || null,
    lifecycle_stage: input.lifecycle_stage as LifecycleStage,
    source: input.source || null,
    job_title: input.job_title || null,
    office_phone: input.office_phone || null,
    role_type: readList(formData, 'role_type'),
    priority: input.priority || null,
    credibility: input.credibility || null,
    birthday: input.birthday || null,
    notes: input.notes.trim() || null,
    website: input.website || null,
    facebook: input.facebook || null,
    instagram: input.instagram || null,
    tiktok: input.tiktok || null,
    x_twitter: input.x_twitter || null,
    linkedin: input.linkedin || null,
    links: readLinks(formData),
    custom_fields: readCustomFields(formData),
  }
}

export type ActionState = { ok?: boolean; error?: string; duplicates?: ContactRow[]; id?: string }

/**
 * Duplicate detection on save (acceptance criterion 6.2): a matching email, or
 * matching name + phone, comes back as a merge suggestion instead of silently
 * creating a second record. `force` is the user saying "no, these are
 * different people".
 */
export async function createContact(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireSession()
  if (!context.canWrite) return { error: 'Your role does not allow creating contacts.' }

  const parsed = contactSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid contact details' }
  }
  const input = parsed.data
  const force = formData.get('force') === 'true'

  if (!force) {
    const { data: duplicates } = await context.supabase.rpc('find_duplicate_contacts', {
      p_email: input.email || null,
      p_first_name: input.first_name || null,
      p_last_name: input.last_name || null,
      p_phone: input.phone || null,
      p_exclude_id: null,
    })

    if (duplicates && duplicates.length > 0) {
      return { duplicates }
    }
  }

  // No explicit owner? Routing rules decide (6.5), falling back to the creator.
  let ownerId: string | null = input.owner_id || null
  if (!ownerId) {
    const { data: assignee } = await context.supabase.rpc('next_assignee', {
      p_source: input.source || null,
    })
    ownerId = assignee ?? context.user.id
  }

  const company = await resolveCompanyId(context, input.company_id, formData)
  if (company.error) return { error: company.error }

  const { data, error } = await scoped(context, 'contacts')
    .insert({ ...contactColumns(input, formData), owner_id: ownerId, company_id: company.id })
    .select('id')
    .single()

  if (error) return { error: error.message }

  /*
   * After the insert, because a tag hangs off the contact's id and there is no
   * id until the row exists. That is the whole reason tagging used to be a
   * second trip to the record — the form could ask the question, but the answer
   * had nowhere to go until now.
   */
  const tagIds = tagIdsFrom(formData)
  if (tagIds) await syncTags(context, 'contact', data.id, tagIds)

  revalidatePath('/contacts')
  revalidatePath('/companies')
  redirect(`/contacts/${data.id}`)
}

export async function updateContact(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireSession()
  if (!context.canWrite) return { error: 'Your role does not allow editing contacts.' }

  const id = String(formData.get('id') ?? '')
  if (!id) return { error: 'Missing contact id' }

  const parsed = contactSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid contact details' }
  }
  const input = parsed.data

  const company = await resolveCompanyId(context, input.company_id, formData)
  if (company.error) return { error: company.error }

  /*
   * Ownership is left alone for anyone but a manager. A rep's edit form does
   * not render the field, and quietly writing owner_id from a posted value
   * would let a crafted request move a record — or fail against RLS for an
   * ordinary edit, since a row whose owner changes leaves the writer's sight.
   * Handover goes through reassignContact instead.
   */
  const ownership = context.canManage ? { owner_id: input.owner_id || null } : {}

  const { error } = await scoped(context, 'contacts')
    .update({ ...contactColumns(input, formData), ...ownership, company_id: company.id })
    .eq('id', id)

  if (error) return { error: error.message }

  const tagIds = tagIdsFrom(formData)
  if (tagIds) await syncTags(context, 'contact', id, tagIds)

  revalidatePath('/contacts')
  revalidatePath(`/contacts/${id}`)
  return { ok: true }
}

/**
 * Deleting stamps the record rather than destroying it. It leaves everyone's
 * view except an administrator's, who can restore it, and the administrators
 * are notified. Routed through a definer function because the stamped row stops
 * satisfying the writer's own SELECT policy — the same reason handover needs
 * one.
 */
export async function deleteContact(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('soft_delete_contact', { p_contact_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/contacts')
  redirect('/contacts')
}

/** POST /contacts/{id}/merge, as a server action for the in-app merge flow. */
export async function mergeContactsAction(formData: FormData) {
  const context = await requireSession()
  // A merge folds one record into another and tombstones the loser — close
  // enough to a delete to sit with managers.
  assertCanManage(context)
  const targetId = String(formData.get('target_id') ?? '')
  const sourceId = String(formData.get('source_id') ?? '')

  const { error } = await context.supabase.rpc('merge_contacts', {
    p_target_id: targetId,
    p_source_id: sourceId,
  })

  if (error) throw new Error(error.message)

  revalidatePath('/contacts')
  redirect(`/contacts/${targetId}?merged=1`)
}

/** The record page's own tag form. The create and edit forms carry one too. */
export async function setContactTags(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)
  const contactId = String(formData.get('contact_id') ?? '')

  await syncTags(context, 'contact', contactId, formData.getAll('tag_ids').map(String).filter(Boolean))

  revalidatePath(`/contacts/${contactId}`)
}

const savedFilterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  entity_type: z
    .enum(['contact', 'company', 'deal', 'campaign', 'product', 'marketplace'])
    .default('contact'),
  filter_json: z.string(),
  is_shared: z.boolean().default(false),
})

export async function saveFilter(formData: FormData) {
  const context = await requireSession()

  const parsed = savedFilterSchema.safeParse({
    name: formData.get('name'),
    entity_type: formData.get('entity_type') ?? 'contact',
    filter_json: formData.get('filter_json') ?? '{}',
    is_shared: formData.get('is_shared') === 'on',
  })

  if (!parsed.success) throw new Error('A saved filter needs a name')

  const { error } = await scoped(context, 'saved_filters').insert({
    name: parsed.data.name,
    entity_type: parsed.data.entity_type,
    filter_json: JSON.parse(parsed.data.filter_json),
    is_shared: parsed.data.is_shared,
    user_id: context.user.id,
  })

  if (error) throw new Error(error.message)

  // The list the view was saved from, so it appears under "Saved views" without
  // a reload. Five screens share this action now, and revalidating /contacts
  // for all of them would leave four of them stale.
  revalidatePath(String(formData.get('return_to') ?? '/contacts'))
}

export async function deleteSavedFilter(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')
  const returnTo = String(formData.get('return_to') ?? '/contacts')

  await scoped(context, 'saved_filters').delete().eq('id', id)
  revalidatePath(returnTo)
}

/**
 * Hands a contact to a colleague.
 *
 * Routed through a database function because a plain UPDATE cannot do it: under
 * FORCE ROW LEVEL SECURITY the updated row must still satisfy the SELECT
 * policy, and a record owned by someone else is invisible by definition. The
 * function does its own authorisation — you may give away what you can see,
 * and nothing else.
 */
export async function reassignContact(formData: FormData) {
  const context = await requireSession()
  assertCanBulk(context)

  const contactId = String(formData.get('contact_id') ?? '')
  const ownerId = String(formData.get('owner_id') ?? '')

  const { error } = await context.supabase.rpc('reassign_contact', {
    p_contact_id: contactId,
    p_new_owner_id: ownerId || null,
  })

  if (error) throw new Error(error.message)

  revalidatePath('/contacts')
  revalidatePath(`/contacts/${contactId}`)
}

/**
 * The manual yes-or-no on whether a contact may be emailed.
 *
 * Three states, so an empty value is meaningful rather than missing: it puts
 * the contact back under the consent rules. What this cannot do is reach past
 * an unsubscribe or a bounced address — that is enforced in the mailability
 * view rather than here, so it holds however the column is written.
 */
export async function setMailableOverride(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  if (!context.canWrite) {
    redirect(`/contacts/${id}?error=Your+role+does+not+allow+editing+contacts`)
  }

  const raw = String(formData.get('mailable_override') ?? '')
  const override = raw === 'true' ? true : raw === 'false' ? false : null

  const { error } = await scoped(context, 'contacts')
    .update({ mailable_override: override })
    .eq('id', id)

  if (error) redirect(`/contacts/${id}?error=${encodeURIComponent(error.message)}`)

  revalidatePath(`/contacts/${id}`)
  revalidatePath('/contacts')
  redirect(`/contacts/${id}`)
}

/**
 * Takes a contact out of everybody's sight, or puts it back.
 *
 * The permission is not checked here. A trigger on the table refuses the change
 * for anybody without see_hidden, and it is the trigger's message that comes
 * back — checking twice would mean two wordings to keep in step, and only one
 * of them is the one that actually holds.
 */
export async function setContactHidden(
  _state: ButtonState,
  formData: FormData,
): Promise<ButtonState> {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')
  const hidden = formData.get('hidden') === 'true'

  const { error } = await scoped(context, 'contacts').update({ hidden }).eq('id', id)
  if (error) return { error: error.message }

  revalidatePath('/contacts')
  revalidatePath(`/contacts/${id}`)
  return {}
}
