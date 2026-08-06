'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'

const dealSchema = z.object({
  name: z.string().trim().min(1, 'A deal needs a name').max(200),
  contact_id: z.string().uuid().or(z.literal('')).default(''),
  company_id: z.string().uuid().or(z.literal('')).default(''),
  stage_id: z.string().uuid('Pick a stage'),
  value: z.coerce.number().min(0).default(0),
  currency: z.string().trim().min(3).max(3).default('CAD'),
  probability: z.string().trim().default(''),
  expected_close_date: z.string().trim().default(''),
  status: z.enum(['open', 'won', 'lost']).default('open'),
  owner_id: z.string().uuid().or(z.literal('')).default(''),
})

export type DealActionState = { ok?: boolean; error?: string }

export async function createDeal(_prev: DealActionState, formData: FormData): Promise<DealActionState> {
  const context = await requireSession()

  const parsed = dealSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid deal' }
  const input = parsed.data

  // A probability typed in by hand is an override; leaving it blank means
  // "follow the stage default", which the database trigger then applies.
  const overridden = input.probability !== ''

  const { data, error } = await scoped(context, 'deals')
    .insert({
      name: input.name,
      contact_id: input.contact_id || null,
      company_id: input.company_id || null,
      stage_id: input.stage_id,
      value: input.value,
      currency: input.currency.toUpperCase(),
      ...(overridden ? { probability: Number(input.probability) / 100 } : {}),
      probability_overridden: overridden,
      expected_close_date: input.expected_close_date || null,
      status: input.status,
      owner_id: input.owner_id || context.user.id,
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  revalidatePath('/deals')
  redirect(`/deals/${data.id}`)
}

export async function updateDeal(_prev: DealActionState, formData: FormData): Promise<DealActionState> {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const parsed = dealSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid deal' }
  const input = parsed.data

  const existing = await firstRow<{
    probability: number
    stage_id: string
    probability_overridden: boolean
  }>(
    scoped(context, 'deals')
      .select('probability, stage_id, probability_overridden')
      .eq('id', id)
      .maybeSingle(),
  )

  const typed = input.probability === '' ? null : Number(input.probability) / 100
  // Only count it as an override if the user actually changed the number.
  const overridden =
    typed === null
      ? false
      : existing
        ? Math.abs(typed - existing.probability) > 0.0005 || existing.probability_overridden
        : true

  const { error } = await scoped(context, 'deals')
    .update({
      name: input.name,
      contact_id: input.contact_id || null,
      company_id: input.company_id || null,
      stage_id: input.stage_id,
      value: input.value,
      currency: input.currency.toUpperCase(),
      ...(typed === null ? {} : { probability: typed }),
      probability_overridden: overridden,
      expected_close_date: input.expected_close_date || null,
      status: input.status,
      owner_id: input.owner_id || null,
    })
    .eq('id', id)

  if (error) return { error: error.message }

  revalidatePath('/deals')
  revalidatePath(`/deals/${id}`)
  return { ok: true }
}

/**
 * Kanban drag-and-drop target (acceptance criterion 6.3).
 *
 * The new probability is *not* written here: the deals_apply_stage_probability
 * trigger applies the destination stage's default, and skips it when the user
 * has overridden the probability. One rule, one place.
 */
export async function moveDealToStage(dealId: string, stageId: string, position?: number) {
  const context = await requireSession()

  const { error } = await scoped(context, 'deals')
    .update({ stage_id: stageId, ...(position === undefined ? {} : { position }) })
    .eq('id', dealId)

  if (error) return { error: error.message }

  revalidatePath('/deals')
  revalidatePath(`/deals/${dealId}`)
  return { ok: true }
}

export async function resetDealProbability(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const deal = await firstRow<{ stage_id: string }>(
    scoped(context, 'deals').select('stage_id').eq('id', id).maybeSingle(),
  )

  if (!deal) throw new Error('Deal not found')

  const stage = await firstRow<{ default_probability: number }>(
    scoped(context, 'stages').select('default_probability').eq('id', deal.stage_id).maybeSingle(),
  )

  await scoped(context, 'deals')
    .update({ probability_overridden: false, probability: stage?.default_probability ?? 0.5 })
    .eq('id', id)

  revalidatePath(`/deals/${id}`)
}

export async function deleteDeal(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'deals').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/deals')
  redirect('/deals')
}
