'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanWrite, requireSession, scoped } from '@/lib/tenancy'
import { settableInvoiceStatuses } from '@/lib/sales'
import type { InvoiceStatus, RevisedRateType } from '@/lib/database.types'

/**
 * Invoices: the header, the payment ledger, and voiding one.
 *
 * Nothing here writes a total, and nothing here writes amount_paid. Those come
 * from the conversion and from the ledger's trigger respectively — an invoice
 * cannot be marked paid without money behind it, and that is enforced a layer
 * below this file rather than by its good manners.
 */

const text = (max: number) => z.string().trim().max(max).default('')

const headerSchema = z.object({
  due_date: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
  payment_terms: text(200),
  notes: z.string().max(20_000).default(''),
  terms: z.string().max(20_000).default(''),
})

export async function updateInvoice(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const id = formData.get('id') as string
  const parsed = headerSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Those details are not valid')
  }

  const { error } = await scoped(context, 'invoices')
    .update({
      due_date: parsed.data.due_date,
      payment_terms: parsed.data.payment_terms || null,
      notes: parsed.data.notes || null,
      terms: parsed.data.terms || null,
    })
    .eq('id', id)

  if (error) throw new Error(error.message)

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${id}`)
}

/**
 * Marks an invoice sent, or voids it.
 *
 * Only those two. Paid and part paid are computed from the ledger, and offering
 * them here would be a way to say an invoice was settled without any money
 * arriving — which is exactly the hole the ledger exists to close.
 */
export async function setInvoiceStatus(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const id = formData.get('id') as string
  const next = formData.get('status') as InvoiceStatus

  const { data: invoice, error: readError } = await scoped(context, 'invoices')
    .select('status')
    .eq('id', id)
    .maybeSingle()

  if (readError) throw new Error(readError.message)
  if (!invoice) throw new Error('Invoice not found')

  if (!settableInvoiceStatuses(invoice.status).includes(next)) {
    throw new Error(
      next === 'paid' || next === 'partial'
        ? 'Record a payment instead — an invoice is paid when the money is on it.'
        : `This invoice cannot be marked ${next}.`,
    )
  }

  const { error } = await scoped(context, 'invoices').update({ status: next }).eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${id}`)
}

const paymentSchema = z.object({
  amount: z.coerce
    .number()
    .refine((value) => value !== 0 && Number.isFinite(value), 'Enter an amount that is not zero'),
  method: text(80),
  note: text(300),
  paid_at: text(40),
})

/**
 * Appends to the payment ledger.
 *
 * The trigger behind this recomputes amount_paid and the status from the whole
 * ledger, refuses a void invoice, and refuses a reversal that would take the
 * total below zero. This function's job is to pass the row along and let those
 * messages come back as they are.
 */
export async function recordPayment(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const invoiceId = formData.get('invoice_id') as string
  const parsed = paymentSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'That payment is not valid')
  }

  const { error } = await scoped(context, 'invoice_payments').insert({
    organization_id: context.organizationId,
    invoice_id: invoiceId,
    amount: parsed.data.amount,
    method: parsed.data.method || null,
    note: parsed.data.note || null,
    ...(parsed.data.paid_at ? { paid_at: new Date(parsed.data.paid_at).toISOString() } : {}),
    created_by: context.user.id,
  })

  if (error) throw new Error(error.message)

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${invoiceId}`)
}

/**
 * Deletes an invoice outright. Administrators only, and rarely the right answer
 * — voiding leaves the number in the sequence, which is what an audit expects.
 * It exists because deleting frees the order to be invoiced again, which is the
 * only way back from an invoice raised against the wrong order.
 */
export async function deleteInvoice(formData: FormData) {
  const context = await requireSession()
  const id = formData.get('id') as string

  if (!context.isAdmin) {
    throw new Error('Only an administrator can delete an invoice. Void it instead.')
  }

  const { error } = await scoped(context, 'invoices').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/invoices')
  redirect('/invoices')
}

// -----------------------------------------------------------------------------
// Raising one without a sales order
//
// An invoice usually comes from an order, and that path snapshots the order and
// freezes. This one is composed instead: a draft that can be built up, then
// issued. The database is what decides which of the two a given invoice is —
// every write below goes through a function that refuses anything already
// issued, or anything that came from an order.
// -----------------------------------------------------------------------------

export async function createInvoice(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const { data, error } = await context.supabase.rpc('create_invoice', {
    p_company_id: (formData.get('company_id') as string) || null,
    p_contact_id: (formData.get('contact_id') as string) || null,
    p_owner_id: null,
    p_currency: ((formData.get('currency') as string) || '').trim() || null,
  })

  if (error) throw new Error(error.message)

  revalidatePath('/invoices')
  redirect(`/invoices/${data}`)
}

const lineSchema = z
  .object({
    product_id: z
      .string()
      .trim()
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .default(null),
    name: text(200),
    notes: text(500),
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
  .refine((line) => Boolean(line.product_id) || Boolean(line.name), {
    message: 'Each line needs a product or a description',
  })
  .refine((line) => (line.revised_rate_type === null) === (line.revised_rate === null), {
    message: 'A revised rate needs both a kind and a value',
  })

export async function addInvoiceLine(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const invoiceId = formData.get('invoice_id') as string
  const parsed = lineSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'That line is not valid')
  }

  // No discount is sent. The function computes it from the rate with the same
  // SQL the sales order lines use, so the two documents cannot price a line
  // differently.
  const { error } = await context.supabase.rpc('add_invoice_line', {
    p_invoice_id: invoiceId,
    p_product_id: parsed.data.product_id,
    p_name: parsed.data.name || null,
    p_quantity: parsed.data.quantity,
    p_unit_price: parsed.data.unit_price,
    p_unit_cost: parsed.data.unit_cost,
    p_rate_type: parsed.data.revised_rate_type as RevisedRateType | null,
    p_rate: parsed.data.revised_rate,
    p_notes: parsed.data.notes || null,
  })

  if (error) throw new Error(error.message)

  revalidatePath(`/invoices/${invoiceId}`)
}

export async function removeInvoiceLine(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const invoiceId = formData.get('invoice_id') as string

  const { error } = await context.supabase.rpc('remove_invoice_line', {
    p_line_id: formData.get('id') as string,
  })

  if (error) throw new Error(error.message)

  revalidatePath(`/invoices/${invoiceId}`)
}

/** Shipping is a header field, but it moves the total, so it lives with the lines. */
export async function setInvoiceShipping(formData: FormData) {
  const context = await requireSession()
  assertCanWrite(context)

  const id = formData.get('id') as string
  const shipping = Number(formData.get('shipping_charge') ?? 0)

  if (!Number.isFinite(shipping) || shipping < 0) {
    throw new Error('Shipping has to be a number, and cannot be negative')
  }

  const { error } = await scoped(context, 'invoices')
    .update({ shipping_charge: shipping })
    .eq('id', id)

  if (error) throw new Error(error.message)

  revalidatePath(`/invoices/${id}`)
}
