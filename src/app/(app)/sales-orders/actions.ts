'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanWrite, requireSession, scoped } from '@/lib/tenancy'
import type { ActionState } from '@/components/action-form'
import { CURRENCIES } from '@/lib/format'
import { canTransition, isEditable } from '@/lib/sales'
import type { RevisedRateType, SalesOrderStatus } from '@/lib/database.types'

/**
 * Sales orders: creating one, editing its header, its lines and its deposits.
 *
 * The money is not here. A line's discount is written by a database trigger and
 * its total is a generated column, so nothing in this file computes an amount —
 * it sends quantities and prices and reads back what they came to. That is the
 * point: there is one implementation of the arithmetic and it is the one the
 * database will apply whatever sends the row.
 */

const text = (max: number) => z.string().trim().max(max).default('')
const optionalId = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .default(null)

// -----------------------------------------------------------------------------
// The order itself
// -----------------------------------------------------------------------------

export async function createSalesOrder(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const companyId = (formData.get('company_id') as string) || null
  const contactId = (formData.get('contact_id') as string) || null
  const currency = ((formData.get('currency') as string) || '').trim() || null

  /*
   * A function rather than an insert, because the SO number has to be allocated
   * in the same transaction as the row it goes on. Two people clicking New at
   * the same moment must not take the same number.
   */
  const { data, error } = await context.supabase.rpc('create_sales_order', {
    p_company_id: companyId,
    p_contact_id: contactId,
    p_owner_id: null,
    p_currency: currency,
  })

  if (error) throw new Error(error.message)

  revalidatePath('/sales-orders')
  redirect(`/sales-orders/${data}`)
}

const headerSchema = z.object({
  company_id: optionalId,
  contact_id: optionalId,
  owner_id: optionalId,
  location_id: optionalId,
  /*
   * Optional, with no default. The picker is disabled once the order leaves
   * draft, so the browser sends nothing — and a default here would write that
   * default over the order's real currency on every unrelated save.
   */
  currency: z.enum(CURRENCIES).optional().catch(undefined),
  /* Blank is "direct", which is a real answer and has to reach null. */
  marketplace_id: optionalId,
  /* Where it goes, when that is not who is billed. */
  ship_to_company_id: optionalId,
  ship_to_contact_id: optionalId,
  shipping_address: z.string().max(2_000).default(''),
  shipping_method: text(120),
  shipping_responsibility: text(120),
  /* A checkbox, sent as a pair — see the note on the card that renders it. */
  deposit_required: z
    .string()
    .trim()
    .transform((value) => value === 'true' || value === 'on')
    .default('false'),
  deposit_information: z.string().max(2_000).default(''),
  order_date: z.string().trim().min(1),
  payment_terms: text(200),
  shipping_charge: z.coerce.number().min(0).default(0),
  notes: z.string().max(20_000).default(''),
  terms: z.string().max(20_000).default(''),
})

/**
 * The columns that mean "nothing" rather than "leave it alone" when blank.
 *
 * Everything else on the header is text, and text that arrives empty from a
 * form that asked for it is somebody clearing the field.
 */
const HEADER_NULLABLE = new Set([
  'payment_terms',
  'notes',
  'terms',
  'shipping_address',
  'shipping_method',
  'shipping_responsibility',
  'deposit_information',
])

export async function updateSalesOrder(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  assertCanWrite(context)

  const id = formData.get('id') as string
  const parsed = headerSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Those details are not valid' }
  }

  /*
   * A form that does not ask about a value must not answer for it.
   *
   * The header is spread across several cards now — who it is for, what it
   * is, how it ships, what it says — and each posts on its own. Every field
   * parses to null or '' when absent, so without this rule saving the notes
   * would wipe the shipping method, and saving the shipping would wipe the
   * notes. `has` is the only honest test: HTML gives the server no way to tell
   * a cleared field from one that was never on the page, so the presence of
   * the key is the question being asked.
   *
   * Built by walking what parsed rather than by naming the fields twice. A
   * field added to the schema and to a card is then carried without anybody
   * remembering to add it here as well.
   */
  const patch: Record<string, unknown> = { updated_by: context.user.id }

  for (const [key, value] of Object.entries(parsed.data)) {
    if (!formData.has(key)) continue
    // A currency the picker disabled arrives as nothing rather than as blank.
    if (key === 'currency' && !value) continue
    patch[key] = HEADER_NULLABLE.has(key) ? (value as string) || null : value
  }

  const { error } = await scoped(context, 'sales_orders')
    .update(patch)
    .eq('id', id)

  if (error) throw new Error(error.message)

  revalidatePath('/sales-orders')
  revalidatePath(`/sales-orders/${id}`)
  return { ok: 'Saved.' }
}

/**
 * Moves an order along.
 *
 * The transition is checked here so the interface refuses what the business
 * refuses; nothing about it is enforced in the database, because a status is a
 * statement about intent rather than an invariant about money. The two rules
 * that *are* invariants — no invoicing before confirmation, no deposits on a
 * cancelled order — live in SQL where they cannot be gone around.
 */
export async function setSalesOrderStatus(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  assertCanWrite(context)

  const id = formData.get('id') as string
  const next = formData.get('status') as SalesOrderStatus

  const { data: order, error: readError } = await scoped(context, 'sales_orders')
    .select('status')
    .eq('id', id)
    .maybeSingle()

  if (readError) throw new Error(readError.message)
  if (!order) return { error: 'Sales order not found' }

  if (!canTransition(order.status, next)) {
    return { error: `A ${order.status} order cannot become ${next}.` }
  }

  const { error } = await scoped(context, 'sales_orders')
    .update({
      status: next,
      // Reserving is what "signed" means, and the stamp is what dates it.
      ...(next === 'reserved' ? { signed_at: new Date().toISOString() } : {}),
      updated_by: context.user.id,
    })
    .eq('id', id)

  if (error) throw new Error(error.message)

  revalidatePath('/sales-orders')
  revalidatePath(`/sales-orders/${id}`)
  return { ok: `Marked ${next}.` }
}

export async function deleteSalesOrder(formData: FormData) {
  const context = await requireSession()
  const id = formData.get('id') as string

  const { error } = await context.supabase.rpc('soft_delete_sales_order', {
    p_sales_order_id: id,
  })
  if (error) throw new Error(error.message)

  revalidatePath('/sales-orders')
  redirect('/sales-orders')
}

// -----------------------------------------------------------------------------
// Lines
// -----------------------------------------------------------------------------

const lineSchema = z
  .object({
    product_id: optionalId,
    description: text(200),
    notes: text(500),
    /* How many what. Blank falls back to the product's own unit — see
       20260263000000 — so it is stored as null rather than as ''. */
    unit: text(40),
    quantity: z.coerce.number().min(0).default(1),
    unit_price: z.coerce.number().min(0).default(0),
    unit_cost: z.coerce.number().min(0).default(0),
    revised_rate_type: z
      .string()
      .trim()
      .transform((value) => (value === '' ? null : value))
      .refine((value) => value === null || value === 'percent' || value === 'fixed', {
        message: 'A revised rate is either a percentage or a fixed price',
      })
      .nullable()
      .default(null),
    revised_rate: z
      .string()
      .trim()
      .transform((value) => (value === '' ? null : Number(value)))
      .refine((value) => value === null || (Number.isFinite(value) && value >= 0), {
        message: 'A revised rate has to be a number, and cannot be negative',
      })
      .nullable()
      .default(null),
  })
  .refine((line) => Boolean(line.product_id) || Boolean(line.description), {
    message: 'Each line needs a product or a description',
  })
  // Half a pair is a line nobody can price. The database refuses it too; this
  // says so in words rather than as a constraint violation.
  .refine((line) => (line.revised_rate_type === null) === (line.revised_rate === null), {
    message: 'A revised rate needs both a kind and a value',
  })

/**
 * Refuses to touch an order that is finished with, before writing anything.
 *
 * Returns the refusal rather than throwing it, and null when the lines are
 * open, so each caller can hand it back to the form it came from. The screen
 * hides these controls on an order that is closed, which means the refusal is
 * mostly reached the way it actually happens: two tabs, where the order was
 * marked shipped in one while a line was being edited in the other. Thrown,
 * that arrived as "Application error" on top of losing the edit.
 */
async function lineEditRefusal(
  context: Awaited<ReturnType<typeof requireSession>>,
  orderId: string,
): Promise<ActionState | null> {
  const { data: order, error } = await scoped(context, 'sales_orders')
    .select('status')
    .eq('id', orderId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!order) return { error: 'Sales order not found' }
  if (!isEditable(order.status)) {
    return { error: `A ${order.status} order cannot have its lines changed.` }
  }
  return null
}

export async function addSalesOrderLine(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  assertCanWrite(context)

  const orderId = formData.get('sales_order_id') as string
  const refusal = await lineEditRefusal(context, orderId)
  if (refusal) return refusal

  const parsed = lineSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That line is not valid' }
  }

  // Appended, so a line lands where the person who added it will look for it.
  const { data: last } = await scoped(context, 'sales_order_lines')
    .select('position')
    .eq('sales_order_id', orderId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { error } = await scoped(context, 'sales_order_lines').insert({
    organization_id: context.organizationId,
    sales_order_id: orderId,
    ...parsed.data,
    description: parsed.data.description || null,
    notes: parsed.data.notes || null,
    unit: parsed.data.unit || null,
    revised_rate_type: parsed.data.revised_rate_type as RevisedRateType | null,
    position: (last?.position ?? -1) + 1,
  })

  if (error) throw new Error(error.message)

  revalidatePath(`/sales-orders/${orderId}`)
  return { ok: 'Line added.' }
}

/**
 * Changes a line that is already on the order.
 *
 * The lines are edited where they are read now, which needs a write that is not
 * "delete it and add it back": that loses the line's position and its id, and
 * an order whose lines reshuffle every time somebody fixes a quantity is an
 * order nobody trusts.
 *
 * The whole line is posted rather than one field, because the fields are not
 * independent — quantity, price and the revised rate together decide the
 * discount and the total, and the database derives both from whatever it is
 * given. Sending one of the three would mean the other two arriving from a
 * stale copy of the row.
 *
 * `lineEditRefusal` is the same guard the other two use: an order that has
 * shipped is not one whose lines may change, and the check happens before the
 * write rather than in the interface that hid the control.
 */
export async function updateSalesOrderLine(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  assertCanWrite(context)

  const id = formData.get('id') as string
  const orderId = formData.get('sales_order_id') as string
  if (!id) return { error: 'No line to change.' }

  const refusal = await lineEditRefusal(context, orderId)
  if (refusal) return refusal

  const parsed = lineSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That line is not valid' }
  }

  const { error } = await scoped(context, 'sales_order_lines')
    .update({
      ...parsed.data,
      description: parsed.data.description || null,
      notes: parsed.data.notes || null,
      unit: parsed.data.unit || null,
      revised_rate_type: parsed.data.revised_rate_type as RevisedRateType | null,
    })
    .eq('id', id)
    .eq('sales_order_id', orderId)

  if (error) throw new Error(error.message)

  revalidatePath(`/sales-orders/${orderId}`)
  return { ok: 'Line saved.' }
}

export async function removeSalesOrderLine(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  assertCanWrite(context)

  const id = formData.get('id') as string
  const orderId = formData.get('sales_order_id') as string
  const refusal = await lineEditRefusal(context, orderId)
  if (refusal) return refusal

  const { error } = await scoped(context, 'sales_order_lines').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath(`/sales-orders/${orderId}`)
  return { ok: 'Line removed.' }
}

// -----------------------------------------------------------------------------
// Deposits
// -----------------------------------------------------------------------------

const paymentSchema = z.object({
  amount: z.coerce
    .number()
    .refine((value) => value !== 0 && Number.isFinite(value), 'Enter an amount that is not zero'),
  method: text(80),
  note: text(300),
  paid_at: text(40),
})

/**
 * Adds a row to the deposit ledger.
 *
 * There is no edit and no delete, here or anywhere: a correction is a reversing
 * row with a negative amount. The table has no update policy at all, so this is
 * a property of the database rather than a habit of this file.
 */
export async function recordDeposit(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  assertCanWrite(context)

  const orderId = formData.get('sales_order_id') as string
  const parsed = paymentSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That deposit is not valid' }
  }

  const { error } = await scoped(context, 'sales_order_payments').insert({
    organization_id: context.organizationId,
    sales_order_id: orderId,
    amount: parsed.data.amount,
    method: parsed.data.method || null,
    note: parsed.data.note || null,
    // The trigger refuses a cancelled or already-invoiced order and a reversal
    // that would take the ledger below zero; those messages come back verbatim.
    ...(parsed.data.paid_at ? { paid_at: new Date(parsed.data.paid_at).toISOString() } : {}),
    created_by: context.user.id,
  })

  if (error) return { error: error.message }

  revalidatePath(`/sales-orders/${orderId}`)
  return { ok: 'Deposit recorded.' }
}

// -----------------------------------------------------------------------------
// Invoicing
// -----------------------------------------------------------------------------

/**
 * Turns a confirmed order into an invoice.
 *
 * All of the work is one SQL function, because a half-written invoice is worse
 * than none: the number, the header, the snapshot lines and the carried-over
 * deposits either all land or none do. It is idempotent, so two people clicking
 * this get one invoice rather than two debts.
 */
export async function convertToInvoice(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const orderId = formData.get('id') as string

  const { data, error } = await context.supabase.rpc('convert_sales_order_to_invoice', {
    p_sales_order_id: orderId,
  })

  if (error) throw new Error(error.message)

  revalidatePath('/invoices')
  revalidatePath(`/sales-orders/${orderId}`)
  redirect(`/invoices/${data}`)
}
