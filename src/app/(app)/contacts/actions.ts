'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireSession, scoped } from '@/lib/tenancy'
import { safeUrl } from '@/lib/field-options'
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

/** The columns shared by create and update. */
function contactColumns(input: z.infer<typeof contactSchema>, formData: FormData) {
  return {
    first_name: input.first_name,
    last_name: input.last_name,
    email: input.email || null,
    phone: input.phone || null,
    company_id: input.company_id || null,
    lifecycle_stage: input.lifecycle_stage as LifecycleStage,
    source: input.source || null,
    job_title: input.job_title || null,
    office_phone: input.office_phone || null,
    specialty_market: readList(formData, 'specialty_market'),
    customer_type: readList(formData, 'customer_type'),
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
    links: readLinks(formData),
    custom_fields: readCustomFields(formData),
  }
}

export type ActionState = { ok?: boolean; error?: string; duplicates?: ContactRow[]; id?: string }

function readCustomFields(formData: FormData): Record<string, string | string[]> {
  const custom: Record<string, string | string[]> = {}

  for (const key of new Set([...formData.keys()].filter((k) => k.startsWith('custom.')))) {
    const values = formData.getAll(key).map(String).map((v) => v.trim()).filter(Boolean)
    if (values.length === 0) continue
    // A multiselect posts the same key repeatedly; keep it an array so the
    // stored shape matches how the field is rendered back.
    custom[key.slice('custom.'.length)] = values.length > 1 ? values : values[0]
  }

  return custom
}

/**
 * Duplicate detection on save (acceptance criterion 6.2): a matching email, or
 * matching name + phone, comes back as a merge suggestion instead of silently
 * creating a second record. `force` is the user saying "no, these are
 * different people".
 */
export async function createContact(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireSession()

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

  const { data, error } = await scoped(context, 'contacts')
    .insert({ ...contactColumns(input, formData), owner_id: ownerId })
    .select('id')
    .single()

  if (error) return { error: error.message }

  revalidatePath('/contacts')
  redirect(`/contacts/${data.id}`)
}

export async function updateContact(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')
  if (!id) return { error: 'Missing contact id' }

  const parsed = contactSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid contact details' }
  }
  const input = parsed.data

  const { error } = await scoped(context, 'contacts')
    .update({ ...contactColumns(input, formData), owner_id: input.owner_id || null })
    .eq('id', id)

  if (error) return { error: error.message }

  revalidatePath('/contacts')
  revalidatePath(`/contacts/${id}`)
  return { ok: true }
}

export async function deleteContact(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'contacts').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/contacts')
  redirect('/contacts')
}

/** POST /contacts/{id}/merge, as a server action for the in-app merge flow. */
export async function mergeContactsAction(formData: FormData) {
  const context = await requireSession()
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

export async function setContactTags(formData: FormData) {
  const context = await requireSession()
  const contactId = String(formData.get('contact_id') ?? '')
  const tagIds = formData.getAll('tag_ids').map(String).filter(Boolean)

  await context.supabase
    .from('contact_tags')
    .delete()
    .eq('organization_id', context.organizationId)
    .eq('contact_id', contactId)

  if (tagIds.length > 0) {
    await scoped(context, 'contact_tags').insert(
      tagIds.map((tagId) => ({ contact_id: contactId, tag_id: tagId })),
    )
  }

  revalidatePath(`/contacts/${contactId}`)
}

const savedFilterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  entity_type: z.enum(['contact', 'company', 'deal', 'campaign']).default('contact'),
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
  revalidatePath('/contacts')
}

export async function deleteSavedFilter(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')
  const returnTo = String(formData.get('return_to') ?? '/contacts')

  await scoped(context, 'saved_filters').delete().eq('id', id)
  revalidatePath(returnTo)
}
