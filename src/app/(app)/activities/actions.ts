'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { requireSession, scoped } from '@/lib/tenancy'

const activitySchema = z.object({
  type: z.enum(['call', 'email', 'meeting', 'note', 'task']),
  related_to_type: z.enum(['contact', 'company', 'deal']),
  related_to_id: z.string().uuid(),
  subject: z.string().trim().max(300).default(''),
  body: z.string().trim().max(20_000).default(''),
  due_date: z.string().trim().default(''),
  owner_id: z.string().uuid().or(z.literal('')).default(''),
})

function pathFor(type: string, id: string) {
  return type === 'contact' ? `/contacts/${id}` : type === 'company' ? `/companies/${id}` : `/deals/${id}`
}

export async function logActivity(formData: FormData) {
  const context = await requireSession()

  const parsed = activitySchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid activity')
  const input = parsed.data

  const { error } = await scoped(context, 'activities').insert({
    type: input.type,
    related_to_type: input.related_to_type,
    related_to_id: input.related_to_id,
    subject: input.subject,
    body: input.body || null,
    // Only tasks carry a due date (PRD 5.8).
    due_date: input.type === 'task' && input.due_date ? new Date(input.due_date).toISOString() : null,
    owner_id: input.owner_id || context.user.id,
  })

  if (error) throw new Error(error.message)

  revalidatePath(pathFor(input.related_to_type, input.related_to_id))
  revalidatePath('/activities')
}

export async function toggleActivityComplete(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')
  const complete = formData.get('complete') === 'true'
  const returnTo = String(formData.get('return_to') ?? '/activities')

  const { error } = await scoped(context, 'activities')
    .update({ completed_at: complete ? new Date().toISOString() : null })
    .eq('id', id)

  if (error) throw new Error(error.message)

  revalidatePath(returnTo)
  revalidatePath('/activities')
}

export async function deleteActivity(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')
  const returnTo = String(formData.get('return_to') ?? '/activities')

  const { error } = await scoped(context, 'activities').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath(returnTo)
  revalidatePath('/activities')
}
