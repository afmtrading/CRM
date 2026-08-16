'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanWrite, requireSession } from '@/lib/tenancy'
import type { ActionState } from '@/components/action-form'

/**
 * Promoting a company, demoting it, and the rate card.
 *
 * Nothing here writes a table directly. Every call goes through one of the
 * functions in 20260245000000, which is where the checks live — that a company
 * exists and is visible, that a category is one of the organization's own, that
 * a marketplace is used in at least one direction. This file turns a form into
 * arguments and a refusal into a sentence.
 */

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value ?? '')

/**
 * A number field that was left blank.
 *
 * Empty means "no answer" and has to reach the database as null, because these
 * functions read null as "leave it alone" and zero as a real reserve of nought
 * percent. Sending 0 for an empty box would quietly assert something.
 */
const optionalNumber = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : Number(value)))
  .refine((value) => value === null || Number.isFinite(value), 'That is not a number')

export async function addMarketplace(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  assertCanWrite(context)

  const companyId = String(formData.get('company_id') ?? '')
  if (!companyId) return { error: 'Choose a company first.' }

  const { error } = await context.supabase.rpc('add_marketplace', {
    p_company_id: companyId,
    p_sells: formData.get('sells_through') !== null,
    p_sources: formData.get('sources_from') !== null,
  })

  if (error) return { error: error.message }

  revalidatePath('/marketplaces')
  revalidatePath(`/companies/${companyId}`)
  return { ok: 'Added to Marketplaces.' }
}

export async function removeMarketplace(formData: FormData): Promise<void> {
  const context = await requireSession()
  assertCanWrite(context)

  const companyId = String(formData.get('company_id') ?? '')
  const { error } = await context.supabase.rpc('remove_marketplace', {
    p_company_id: companyId,
  })
  if (error) throw new Error(error.message)

  revalidatePath('/marketplaces')
  revalidatePath(`/companies/${companyId}`)
  // The marketplace page it was on no longer exists.
  redirect(`/companies/${companyId}`)
}

const profileSchema = z.object({
  store_name: optional(200),
  seller_account_id: optional(120),
  store_url: optional(500),
  account_status: optional(80),
  settlement_terms: optional(120),
  payout_method: optional(120),
  payout_currency: optional(3),
  notes: z.string().max(20_000).optional().transform((value) => value ?? ''),
  reserve_percent: optionalNumber,
  minimum_lot_value: optionalNumber,
})

export async function updateMarketplace(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  assertCanWrite(context)

  const companyId = String(formData.get('company_id') ?? '')
  const parsed = profileSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Those details are not valid' }
  }

  const openedOn = String(formData.get('opened_on') ?? '').trim()

  const { error } = await context.supabase.rpc('update_marketplace', {
    p_company_id: companyId,
    p_sells: formData.get('sells_through') !== null,
    p_sources: formData.get('sources_from') !== null,
    p_store_name: parsed.data.store_name,
    p_seller_account_id: parsed.data.seller_account_id,
    p_store_url: parsed.data.store_url,
    p_account_status: parsed.data.account_status,
    // A date has no empty string, so a cleared box reaches the function as null
    // — which means "leave it". Clearing a date is not offered rather than
    // offered and silently ignored.
    p_opened_on: openedOn || null,
    p_settlement_terms: parsed.data.settlement_terms,
    p_payout_method: parsed.data.payout_method,
    p_payout_currency: parsed.data.payout_currency,
    p_reserve_percent: parsed.data.reserve_percent,
    p_minimum_lot_value: parsed.data.minimum_lot_value,
    p_notes: parsed.data.notes,
  })

  if (error) return { error: error.message }

  revalidatePath('/marketplaces')
  revalidatePath(`/marketplaces/${companyId}`)
  return { ok: 'Saved.' }
}

export async function setFee(_state: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireSession()
  assertCanWrite(context)

  const marketplaceId = String(formData.get('marketplace_id') ?? '')
  const side = String(formData.get('side') ?? 'sell')

  const number = (name: string) => {
    const raw = String(formData.get(name) ?? '').trim()
    return raw === '' ? 0 : Number(raw)
  }

  for (const name of ['percent', 'fixed_fee', 'processing_percent']) {
    if (!Number.isFinite(number(name))) return { error: 'Those rates are not numbers.' }
  }

  const { error } = await context.supabase.rpc('set_marketplace_fee', {
    p_marketplace_id: marketplaceId,
    p_side: side,
    p_category: String(formData.get('category') ?? '').trim() || null,
    p_percent: number('percent'),
    p_fixed_fee: number('fixed_fee'),
    p_processing_percent: number('processing_percent'),
    p_note: String(formData.get('note') ?? '').trim() || null,
  })

  if (error) return { error: error.message }

  revalidatePath('/marketplaces')
  revalidatePath(`/marketplaces/${marketplaceId}`)
  return { ok: 'Rate saved.' }
}

export async function removeFee(formData: FormData): Promise<void> {
  const context = await requireSession()
  assertCanWrite(context)

  const { error } = await context.supabase.rpc('remove_marketplace_fee', {
    p_fee_id: String(formData.get('fee_id') ?? ''),
  })
  if (error) throw new Error(error.message)

  revalidatePath(`/marketplaces/${String(formData.get('marketplace_id') ?? '')}`)
}
