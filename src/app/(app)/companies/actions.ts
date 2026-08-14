'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanWrite, requireSession, scoped } from '@/lib/tenancy'
// Aliased: this file already has an ActionState of its own, for the record
// forms, whose shape is different.
import type { ActionState as ButtonState } from '@/components/action-form'
import { readCustomFields } from '@/lib/custom-fields'
import { safeUrl } from '@/lib/field-options'
import type { CompanyAddress, ContactLink } from '@/lib/database.types'

const companySchema = z.object({
  name: z.string().trim().min(1, 'A company needs a name').max(200),
  // Surfaced as "Website"; the column stays `domain` so imports and existing
  // rows keep working.
  domain: z.string().trim().max(200).default(''),
  owner_id: z.string().uuid().or(z.literal('')).default(''),
  phone: z.string().trim().max(60).default(''),
  email: z.string().trim().email().or(z.literal('')).default(''),
  notes: z.string().max(20_000).default(''),
  linkedin: z.string().trim().max(300).default(''),
  facebook: z.string().trim().max(300).default(''),
  instagram: z.string().trim().max(300).default(''),
  tiktok: z.string().trim().max(300).default(''),
  x_twitter: z.string().trim().max(300).default(''),
})

export type CompanyActionState = { ok?: boolean; error?: string }

function readList(formData: FormData, name: string): string[] {
  return [...new Set(formData.getAll(name).map(String).map((v) => v.trim()).filter(Boolean))]
}

/**
 * Named links from the Digital card. A URL that will not survive safeUrl() is
 * dropped rather than stored — these end up in href attributes.
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

function readAddresses(formData: FormData): CompanyAddress[] {
  const raw = formData.get('addresses')
  if (typeof raw !== 'string' || !raw.trim()) return []

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((entry): entry is CompanyAddress => Boolean(entry) && typeof entry.address === 'string')
      .map((entry) => ({
        label: String(entry.label ?? '').trim().slice(0, 120),
        address: entry.address.trim().slice(0, 500),
      }))
      .filter((entry) => entry.address.length > 0)
      .slice(0, 25)
  } catch {
    return []
  }
}

function companyColumns(input: z.infer<typeof companySchema>, formData: FormData) {
  return {
    name: input.name,
    domain: input.domain || null,
    phone: input.phone || null,
    email: input.email || null,
    notes: input.notes.trim() || null,
    specialty_market: readList(formData, 'specialty_market'),
    customer_type: readList(formData, 'customer_type'),
    linkedin: input.linkedin || null,
    facebook: input.facebook || null,
    instagram: input.instagram || null,
    tiktok: input.tiktok || null,
    x_twitter: input.x_twitter || null,
    links: readLinks(formData),
    addresses: readAddresses(formData),
    custom_fields: readCustomFields(formData),
  }
}

export async function createCompany(
  _prev: CompanyActionState,
  formData: FormData,
): Promise<CompanyActionState> {
  const context = await requireSession()
  if (!context.canWrite) return { error: 'Your role does not allow creating companies.' }

  const parsed = companySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid company' }

  const { data, error } = await scoped(context, 'companies')
    .insert({
      ...companyColumns(parsed.data, formData),
      owner_id: parsed.data.owner_id || context.user.id,
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  revalidatePath('/companies')
  redirect(`/companies/${data.id}`)
}

export async function updateCompany(
  _prev: CompanyActionState,
  formData: FormData,
): Promise<CompanyActionState> {
  const context = await requireSession()
  if (!context.canWrite) return { error: 'Your role does not allow editing companies.' }

  const id = String(formData.get('id') ?? '')

  const parsed = companySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid company' }

  const { error } = await scoped(context, 'companies')
    .update({ ...companyColumns(parsed.data, formData), owner_id: parsed.data.owner_id || null })
    .eq('id', id)

  if (error) return { error: error.message }

  revalidatePath('/companies')
  revalidatePath(`/companies/${id}`)
  return { ok: true }
}

/** Stamped rather than destroyed — see deleteContact. */
export async function deleteCompany(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('soft_delete_company', { p_company_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/companies')
  redirect('/companies')
}

export async function setCompanyTags(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)
  const companyId = String(formData.get('company_id') ?? '')
  const tagIds = formData.getAll('tag_ids').map(String).filter(Boolean)

  await context.supabase
    .from('company_tags')
    .delete()
    .eq('organization_id', context.organizationId)
    .eq('company_id', companyId)

  if (tagIds.length > 0) {
    await scoped(context, 'company_tags').insert(
      tagIds.map((tagId) => ({ company_id: companyId, tag_id: tagId })),
    )
  }

  revalidatePath(`/companies/${companyId}`)
}

/** The same as setContactHidden, one table over. */
export async function setCompanyHidden(
  _state: ButtonState,
  formData: FormData,
): Promise<ButtonState> {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')
  const hidden = formData.get('hidden') === 'true'

  const { error } = await scoped(context, 'companies').update({ hidden }).eq('id', id)
  if (error) return { error: error.message }

  revalidatePath('/companies')
  revalidatePath(`/companies/${id}`)
  return {}
}
