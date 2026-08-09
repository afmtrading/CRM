'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanManage, requireSession, scoped } from '@/lib/tenancy'

const productSchema = z.object({
  name: z.string().trim().min(1, 'A product needs a name').max(200),
  sku: z.string().trim().max(60).default(''),
  category: z.string().trim().max(120).default(''),
  unit: z.string().trim().max(40).default(''),
  unit_price: z.coerce.number().min(0).default(0),
  unit_cost: z.coerce.number().min(0).default(0),
  currency: z.string().trim().min(3).max(3).default('CAD'),
  description: z.string().max(20_000).default(''),
  active: z.string().optional(),
})

export type ProductActionState = { ok?: boolean; error?: string }

/** Custom fields post as `custom.<key>`, the same shape contacts and companies use. */
function readCustomFields(formData: FormData): Record<string, string | string[]> {
  const custom: Record<string, string | string[]> = {}

  for (const key of new Set([...formData.keys()].filter((k) => k.startsWith('custom.')))) {
    const values = formData.getAll(key).map(String).map((v) => v.trim()).filter(Boolean)
    if (values.length === 0) continue
    custom[key.slice('custom.'.length)] = values.length > 1 ? values : values[0]
  }

  return custom
}

function productColumns(input: z.infer<typeof productSchema>, formData: FormData) {
  return {
    name: input.name,
    sku: input.sku || null,
    category: input.category || null,
    unit: input.unit,
    unit_price: input.unit_price,
    unit_cost: input.unit_cost,
    currency: input.currency.toUpperCase(),
    description: input.description.trim() || null,
    // An unchecked checkbox posts nothing at all, which is the only way a
    // browser says "false".
    active: formData.get('active') !== null,
    custom_fields: readCustomFields(formData),
  }
}

/** A duplicate SKU is the one failure worth explaining in the caller's words. */
function readable(message: string): string {
  return message.includes('products_org_sku_idx') || message.includes('duplicate key')
    ? 'Another product already uses that SKU.'
    : message
}

export async function createProduct(
  _prev: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const context = await requireSession()
  assertCanManage(context)

  const parsed = productSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid product' }

  const { data, error } = await scoped(context, 'products')
    .insert({ ...productColumns(parsed.data, formData), created_by: context.user.id })
    .select('id')
    .single()

  if (error) return { error: readable(error.message) }

  revalidatePath('/products')
  redirect(`/products/${data.id}`)
}

export async function updateProduct(
  _prev: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const context = await requireSession()
  assertCanManage(context)

  const id = String(formData.get('id') ?? '')
  const parsed = productSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid product' }

  const { error } = await scoped(context, 'products')
    .update({ ...productColumns(parsed.data, formData), updated_by: context.user.id })
    .eq('id', id)

  if (error) return { error: readable(error.message) }

  revalidatePath('/products')
  revalidatePath(`/products/${id}`)
  return { ok: true }
}

/**
 * Soft delete, through the database function.
 *
 * Deleting a product never destroys it: deals that already list it keep their
 * frozen prices, the administrators are notified, and the row can be restored
 * from the recycle bin. Retiring a product with the Active switch is the
 * everyday alternative and leaves nothing to restore.
 */
export async function deleteProduct(formData: FormData) {
  const context = await requireSession()
  assertCanManage(context)

  const id = String(formData.get('id') ?? '')
  const { error } = await context.supabase.rpc('soft_delete_product', { p_product_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/products')
  redirect('/products')
}
