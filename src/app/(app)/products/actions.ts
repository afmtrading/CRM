'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanManage, requireSession, scoped } from '@/lib/tenancy'
import { PRODUCT_ACTIVE_STATUS } from '@/lib/products'

/**
 * A price box left empty is not a price of zero.
 *
 * Six of the price columns mean "derive me" when null — showroom and wholesale
 * from retail, the piece prices from the case pack. Coercing an empty string to
 * 0 the way `z.coerce.number()` does would write a real zero into the column
 * and switch the rule off, so the product would be listed at nothing for ever.
 */
const optionalMoney = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isFinite(value) && value >= 0), {
    message: 'A price has to be a number, and cannot be negative',
  })
  .nullable()
  .default(null)

const text = (max: number) => z.string().trim().max(max).default('')

const productSchema = z.object({
  name: z.string().trim().min(1, 'A product needs a name').max(200),
  sku: text(60),
  category: text(120),
  unit_price: z.coerce.number().min(0).default(0),
  unit_cost: z.coerce.number().min(0).default(0),
  currency: z.string().trim().min(3).max(3).default('USD'),
  description: z.string().max(20_000).default(''),

  brand: text(120),
  model: text(120),
  item_count: text(60),
  size: text(60),
  color: text(60),
  case_pack: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : Math.trunc(Number(value))))
    .refine((value) => value === null || (Number.isFinite(value) && value > 0), {
      message: 'A case pack has to be a whole number, at least 1',
    })
    .nullable()
    .default(null),
  item_notes: text(500),
  /*
   * Free text, not an enum: these three are drawn from field_options and an
   * administrator can rename or extend them without a deployment. The database
   * no longer constrains them either — what it does instead is derive
   * products.active from the status, treating "Active" as the one value that
   * means "sell it".
   */
  product_type: text(80),
  product_condition: text(80),
  status: text(80),

  price_showroom: optionalMoney,
  price_wholesale: optionalMoney,
  piece_price_retail: optionalMoney,
  piece_price_showroom: optionalMoney,
  piece_price_wholesale: optionalMoney,
  pallet_price_retail: optionalMoney,
  pallet_price_wholesale: optionalMoney,
  piece_cost: optionalMoney,
  pallet_cost: optionalMoney,

  barcode_url: text(500),
  comp_1_url: text(500),
  comp_2_url: text(500),
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
    unit_price: input.unit_price,
    unit_cost: input.unit_cost,
    currency: input.currency.toUpperCase(),
    description: input.description.trim() || null,

    brand: input.brand || null,
    model: input.model || null,
    item_count: input.item_count || null,
    size: input.size || null,
    color: input.color || null,
    case_pack: input.case_pack,
    item_notes: input.item_notes || null,
    product_type: input.product_type || null,
    product_condition: input.product_condition || null,
    // `active` is deliberately absent: a trigger derives it from the status, so
    // sending one would be sending a second opinion the database throws away.
    status: input.status || PRODUCT_ACTIVE_STATUS,

    price_showroom: input.price_showroom,
    price_wholesale: input.price_wholesale,
    piece_price_retail: input.piece_price_retail,
    piece_price_showroom: input.piece_price_showroom,
    piece_price_wholesale: input.piece_price_wholesale,
    pallet_price_retail: input.pallet_price_retail,
    pallet_price_wholesale: input.pallet_price_wholesale,
    piece_cost: input.piece_cost,
    pallet_cost: input.pallet_cost,

    barcode_url: input.barcode_url || null,
    comp_1_url: input.comp_1_url || null,
    comp_2_url: input.comp_2_url || null,

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
 * from the recycle bin. Setting the status to anything but Active is the
 * everyday alternative — it takes the product off the picker and leaves nothing
 * to restore.
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
