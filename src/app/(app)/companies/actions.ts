'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireSession, scoped } from '@/lib/tenancy'

const companySchema = z.object({
  name: z.string().trim().min(1, 'A company needs a name').max(200),
  domain: z.string().trim().max(200).default(''),
  industry: z.string().trim().max(120).default(''),
  owner_id: z.string().uuid().or(z.literal('')).default(''),
})

export type CompanyActionState = { ok?: boolean; error?: string }

function readCustomFields(formData: FormData): Record<string, string> {
  const custom: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('custom.') && typeof value === 'string' && value.trim() !== '') {
      custom[key.slice('custom.'.length)] = value.trim()
    }
  }
  return custom
}

export async function createCompany(
  _prev: CompanyActionState,
  formData: FormData,
): Promise<CompanyActionState> {
  const context = await requireSession()

  const parsed = companySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid company' }

  const { data, error } = await scoped(context, 'companies')
    .insert({
      name: parsed.data.name,
      domain: parsed.data.domain || null,
      industry: parsed.data.industry || null,
      owner_id: parsed.data.owner_id || context.user.id,
      custom_fields: readCustomFields(formData),
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
  const id = String(formData.get('id') ?? '')

  const parsed = companySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid company' }

  const { error } = await scoped(context, 'companies')
    .update({
      name: parsed.data.name,
      domain: parsed.data.domain || null,
      industry: parsed.data.industry || null,
      owner_id: parsed.data.owner_id || null,
      custom_fields: readCustomFields(formData),
    })
    .eq('id', id)

  if (error) return { error: error.message }

  revalidatePath('/companies')
  revalidatePath(`/companies/${id}`)
  return { ok: true }
}

export async function deleteCompany(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'companies').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/companies')
  redirect('/companies')
}
