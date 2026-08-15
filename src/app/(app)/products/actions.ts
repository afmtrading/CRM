'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanManage, requireSession, scoped } from '@/lib/tenancy'
import { readCustomFields } from '@/lib/custom-fields'
import type { SessionContext } from '@/lib/tenancy'
import { PRODUCT_ACTIVE_STATUS } from '@/lib/products'
import { type StockEntry, normaliseEntries, placeKey } from '@/lib/stock'
import {
  PRODUCT_IMAGE_BUCKET,
  describeImageProblem,
  keyBelongsTo,
  productImageKey,
} from '@/lib/product-image'

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
  // Markdown now, rendered through renderMarkdown() on the record — so it
  // needs the room prose needs rather than the line it used to be.
  item_notes: z.string().max(20_000).default(''),
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
  folder_url: text(500),
  knowledge_base_url: text(500),
})

export type ProductActionState = { ok?: boolean; error?: string }

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
    item_notes: input.item_notes.trim() || null,
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
    folder_url: input.folder_url || null,
    knowledge_base_url: input.knowledge_base_url || null,

    custom_fields: readCustomFields(formData),
  }
}

/**
 * Writes whatever the stock card was holding.
 *
 * Rows arrive as one JSON field because the editor adds and removes them in the
 * browser. Each surviving place goes through set_stock_level, which is the only
 * thing that may move a quantity and which records the movement as it does;
 * places that were on the record and are no longer in the form are cleared, so
 * removing a row is a recorded movement to zero rather than a disappearance.
 *
 * Failures are collected rather than thrown. The product itself has already
 * saved by the time this runs, and losing that save because one warehouse row
 * was wrong would be the worse outcome — so the caller is told which places did
 * not take.
 */
async function applyStock(
  context: SessionContext,
  productId: string,
  formData: FormData,
): Promise<string | null> {
  const raw = formData.get('stock')
  if (raw === null) return null

  let submitted: StockEntry[]
  try {
    const parsed = JSON.parse(String(raw))
    submitted = Array.isArray(parsed) ? (parsed as StockEntry[]) : []
  } catch {
    return 'The stock rows could not be read.'
  }

  const entries = normaliseEntries(submitted)

  const { data: existing } = await scoped(context, 'stock_levels')
    .select('location_id, bin_id')
    .eq('product_id', productId)

  const wanted = new Set(entries.map((entry) => placeKey(entry.location_id, entry.bin_id)))
  const problems: string[] = []

  for (const entry of entries) {
    const { error } = await context.supabase.rpc('set_stock_level', {
      p_product_id: productId,
      p_location_id: entry.location_id,
      p_bin_id: entry.bin_id || null,
      p_quantity: Number(entry.quantity),
      p_reserved: Number(entry.reserved),
      p_reason: 'Edited on the product',
      p_note: null,
      // '' rather than null: null means "leave the note as it was", so an
      // emptied box has to say emptied rather than say nothing.
      p_place_note: entry.note?.trim() ?? '',
    })
    if (error) problems.push(error.message)
  }

  for (const place of (existing ?? []) as { location_id: string; bin_id: string | null }[]) {
    if (wanted.has(placeKey(place.location_id, place.bin_id))) continue

    const { error } = await context.supabase.rpc('clear_stock_level', {
      p_product_id: productId,
      p_location_id: place.location_id,
      p_bin_id: place.bin_id,
      p_reason: 'Removed on the product',
    })
    if (error) problems.push(error.message)
  }

  return problems.length > 0 ? `Saved, but the stock did not: ${problems[0]}` : null
}

/**
 * Puts the product's photo where it belongs, or takes it away.
 *
 * Order matters and is deliberate: the new object is uploaded first, the row is
 * pointed at it, and only then is the old object deleted. Deleting first would
 * mean a failed upload leaves a product with no picture and no way back; this
 * way the worst case is one orphaned file, which costs a few kilobytes and
 * nothing else.
 *
 * The old key is re-checked against the caller's organization before anything
 * is deleted. The storage policies say the same thing and are the real defence
 * — but this code chooses the key to delete, and a value chosen from a row it
 * has just read is worth checking before it is acted on.
 */
async function applyImage(
  context: SessionContext,
  productId: string,
  formData: FormData,
  currentPath: string | null,
): Promise<{ path?: string | null; error?: string }> {
  const organizationId = context.organization.id
  const file = formData.get('image')
  const removing = formData.get('remove_image') === 'true'

  const drop = async (path: string | null) => {
    if (!path || !keyBelongsTo(path, organizationId)) return
    await context.supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([path])
  }

  if (file instanceof File && file.size > 0) {
    const problem = describeImageProblem(file)
    if (problem) return { error: problem }

    const key = productImageKey(organizationId, productId, file.type, crypto.randomUUID())

    const { error } = await context.supabase.storage
      .from(PRODUCT_IMAGE_BUCKET)
      .upload(key, file, { contentType: file.type, upsert: false })

    if (error) return { error: `The image did not upload: ${error.message}` }

    await drop(currentPath)
    return { path: key }
  }

  if (removing) {
    await drop(currentPath)
    return { path: null }
  }

  // Nothing said about the image, so nothing happens to it.
  return {}
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

  // After the insert, because the key contains the product id and there is no
  // product id until the row exists.
  const image = await applyImage(context, data.id, formData, null)
  if (image.error) return { error: image.error }
  if (image.path !== undefined) {
    await scoped(context, 'products').update({ image_path: image.path }).eq('id', data.id)
  }

  const stockError = await applyStock(context, data.id, formData)
  if (stockError) return { error: stockError }

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

  const { data: existing } = await scoped(context, 'products')
    .select('image_path')
    .eq('id', id)
    .maybeSingle()

  const image = await applyImage(
    context,
    id,
    formData,
    ((existing ?? {}) as { image_path?: string | null }).image_path ?? null,
  )
  if (image.error) return { error: image.error }

  const { error } = await scoped(context, 'products')
    .update({
      ...productColumns(parsed.data, formData),
      ...(image.path !== undefined ? { image_path: image.path } : {}),
      updated_by: context.user.id,
    })
    .eq('id', id)

  if (error) return { error: readable(error.message) }

  const stockError = await applyStock(context, id, formData)

  revalidatePath('/products')
  revalidatePath(`/products/${id}`)
  return stockError ? { error: stockError } : { ok: true }
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
