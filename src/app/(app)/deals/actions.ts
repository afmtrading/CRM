'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanWrite, requireSession, scoped, firstRow } from '@/lib/tenancy'
import type { ActionState } from '@/components/action-form'
import { readCustomFields } from '@/lib/custom-fields'

const dealSchema = z.object({
  name: z.string().trim().min(1, 'A deal needs a name').max(200),
  contact_id: z.string().uuid().or(z.literal('')).default(''),
  company_id: z.string().uuid().or(z.literal('')).default(''),
  stage_id: z.string().uuid('Pick a stage'),
  value: z.coerce.number().min(0).default(0),
  currency: z.string().trim().min(3).max(3).default('USD'),
  probability: z.string().trim().default(''),
  expected_close_date: z.string().trim().default(''),
  status: z.enum(['open', 'won', 'lost']).default('open'),
  // Only meaningful on a lost deal. Not constrained to the option list: an
  // import may carry a reason this organization has not written down yet, and
  // dropping it would lose the very thing being recorded.
  loss_reason: z.string().trim().max(120).default(''),
  owner_id: z.string().uuid().or(z.literal('')).default(''),
  // Markdown, like contact and company notes. Bounded so a paste of an entire
  // email thread cannot become the row.
  notes: z.string().trim().max(20000).default(''),
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
      // A reason belongs to a loss. Carrying one on a won or open deal would
      // put a "why we lost" into the reports for a deal nobody lost.
      loss_reason: input.status === 'lost' ? input.loss_reason || null : null,
      owner_id: input.owner_id || context.user.id,
      notes: input.notes || null,
      custom_fields: readCustomFields(formData),
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
    value: number
  }>(
    scoped(context, 'deals')
      .select('probability, stage_id, probability_overridden, value')
      .eq('id', id)
      .maybeSingle(),
  )

  /*
   * Typing a different value is what makes a deal manual. Saving the form
   * without touching the number leaves value_source alone, so a deal that
   * follows its line items keeps following them.
   */
  const valueChanged = existing ? Math.abs(input.value - Number(existing.value)) > 0.005 : true

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
      ...(valueChanged ? { value_source: 'manual' } : {}),
      currency: input.currency.toUpperCase(),
      ...(typed === null ? {} : { probability: typed }),
      probability_overridden: overridden,
      expected_close_date: input.expected_close_date || null,
      status: input.status,
      loss_reason: input.status === 'lost' ? input.loss_reason || null : null,
      owner_id: input.owner_id || null,
      notes: input.notes || null,
      // Replaced wholesale rather than merged: the form posts every field it
      // drew, so a value cleared on screen has to disappear from the record
      // instead of surviving underneath as a value nobody can see.
      custom_fields: readCustomFields(formData),
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

// -----------------------------------------------------------------------------
// Line items
//
// What a deal is actually for. Prices are copied from the product when the line
// is added and then left alone — the database keeps deals.value in step, so
// nothing here writes a total.
// -----------------------------------------------------------------------------

const lineSchema = z.object({
  deal_id: z.string().uuid(),
  product_id: z.string().uuid('Pick a product'),
  quantity: z.coerce.number().min(0).default(1),
  unit_price: z.coerce.number().min(0).default(0),
  unit_cost: z.coerce.number().min(0).default(0),
  discount_pct: z.coerce.number().min(0).max(100).default(0),
})

export async function addDealProduct(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const parsed = lineSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid line item')
  const input = parsed.data

  const { count } = await scoped(context, 'deal_products')
    .select('id', { count: 'exact', head: true })
    .eq('deal_id', input.deal_id)

  const { error } = await scoped(context, 'deal_products').insert({
    deal_id: input.deal_id,
    product_id: input.product_id,
    quantity: input.quantity,
    unit_price: input.unit_price,
    unit_cost: input.unit_cost,
    discount_pct: input.discount_pct,
    position: count ?? 0,
  })

  if (error) throw new Error(error.message)

  revalidatePath(`/deals/${input.deal_id}`)
  revalidatePath('/deals')
}

export async function updateDealProduct(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const id = String(formData.get('id') ?? '')
  const dealId = String(formData.get('deal_id') ?? '')

  const { error } = await scoped(context, 'deal_products')
    .update({
      quantity: Number(formData.get('quantity') ?? 1),
      unit_price: Number(formData.get('unit_price') ?? 0),
      discount_pct: Number(formData.get('discount_pct') ?? 0),
    })
    .eq('id', id)

  if (error) throw new Error(error.message)

  revalidatePath(`/deals/${dealId}`)
  revalidatePath('/deals')
}

export async function removeDealProduct(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const id = String(formData.get('id') ?? '')
  const dealId = String(formData.get('deal_id') ?? '')

  const { error } = await scoped(context, 'deal_products').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath(`/deals/${dealId}`)
  revalidatePath('/deals')
}

/** "Use the line items" — switches the deal off its hand-typed value. */
export async function useLineItemsForValue(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const dealId = String(formData.get('deal_id') ?? '')
  const { error } = await context.supabase.rpc('set_deal_value_from_products', {
    p_deal_id: dealId,
  })

  if (error) throw new Error(error.message)

  revalidatePath(`/deals/${dealId}`)
  revalidatePath('/deals')
}

/**
 * Deleting a deal no longer destroys it.
 *
 * The row is stamped and leaves every view but an administrator's, who can put
 * it back from Settings → Deleted records. A deal is the record of work that
 * was done — an unrecoverable delete was the one thing in this app that could
 * lose it for good.
 */
export async function deleteDeal(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('soft_delete_deal', { p_deal_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/deals')
  redirect('/deals')
}

/**
 * The same delete, from a card on the board.
 *
 * Returns rather than redirects: the board is already the page the user is on,
 * and it removes the card optimistically. Deleting from a kanban card is the
 * quick way to clear a deal that landed in Won or Lost and is finished with —
 * the thing that was missing when dropping a card into Won stopped being a
 * disappearance.
 */
export async function deleteDealFromBoard(dealId: string) {
  const context = await requireSession()

  const { error } = await context.supabase.rpc('soft_delete_deal', { p_deal_id: dealId })
  if (error) return { error: error.message }

  revalidatePath('/deals')
  return { ok: true }
}

// -----------------------------------------------------------------------------
// Saved board views (PRD 6.6)
// -----------------------------------------------------------------------------

/** The parts of the URL a view remembers. Not `view` — see deal-filters.tsx. */
const VIEW_KEYS = ['pipeline', 'owner', 'product', 'status'] as const

/**
 * Remembers the current filters under a name.
 *
 * Stored as an object rather than the query string it came from, so the shape
 * survives the day somebody adds a fourth filter or renames a parameter — a
 * saved string would then replay a URL that no longer means what it did.
 */
export async function saveDealView(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()

  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'A view needs a name' }

  const params = new URLSearchParams(String(formData.get('params') ?? ''))
  const filter: Record<string, string> = {}
  for (const key of VIEW_KEYS) {
    const value = params.get(key)
    if (value) filter[key] = value
  }

  const { error } = await scoped(context, 'saved_filters').insert({
    name: name.slice(0, 80),
    entity_type: 'deal',
    filter_json: filter,
    // Shared views belong to the organization but keep their author, which is
    // how the interface knows who may delete one.
    is_shared: formData.get('is_shared') === 'on',
    user_id: context.user.id,
  })

  if (error) throw new Error(error.message)
  revalidatePath('/deals')
  return { ok: `Saved as ${name.slice(0, 80)}.` }
}

/** Your own views only, shared or not — deleting a colleague's is not offered. */
export async function deleteDealView(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'saved_filters')
    .delete()
    .eq('id', id)
    .eq('user_id', context.user.id)

  if (error) throw new Error(error.message)
  revalidatePath('/deals')
}
