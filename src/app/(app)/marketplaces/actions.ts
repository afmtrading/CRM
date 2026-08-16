'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanWrite, requireSession } from '@/lib/tenancy'
import { parseYesNo } from '@/lib/marketplace'
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
  fee_notes: z.string().max(20_000).optional().transform((value) => value ?? ''),
  payment: optional(80),
  selling_cost: optional(40),
  priority: optional(40),
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

    p_fee_notes: parsed.data.fee_notes,
    /*
     * getAll, because these are multi-selects: a single get would keep the
     * first value and silently drop the rest. An empty array is a real answer —
     * "none of these" — and reaches the function as [] rather than as null,
     * which is what makes clearing one possible.
     */
    p_marketplace_type: formData.getAll('marketplace_type').map(String),
    p_fulfilment: formData.getAll('fulfilment').map(String),
    p_payment: parsed.data.payment,
    p_buyers_premium: parseYesNo(formData.get('buyers_premium')),
    p_selling_cost: parsed.data.selling_cost,
    p_audience: formData.getAll('audience').map(String),
    p_inventory_type: formData.getAll('inventory_type').map(String),
    p_priority: parsed.data.priority,
  })

  if (error) return { error: error.message }

  revalidatePath('/marketplaces')
  revalidatePath(`/marketplaces/${companyId}`)
  return { ok: 'Saved.' }
}
