import { notFound, redirect } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import type {
  CustomFieldDefinitionRow,
  FieldOptionRow,
  ProductRow,
  StockBinRow,
  StockLevelRow,
  StockLocationRow,
  TagRow,
} from '@/lib/database.types'
import { PageHeader } from '@/components/ui'

import { updateProduct } from '../../actions'
import { ProductForm } from '../../product-form'

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()
  if (!context.canManage) redirect(`/products/${id}?error=permission`)

  const product = await firstRow<ProductRow>(
    scoped(context, 'products').select('*').eq('id', id).maybeSingle(),
  )

  if (!product) notFound()

  const [
    { data: customFields },
    { data: fieldOptions },
    { data: locations },
    { data: bins },
    { data: levels },
    { data: summary },
    { data: tags },
    { data: productTags },
  ] = await Promise.all([
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'product').order('order'),
    scoped(context, 'field_options').select('*').order('order'),
    scoped(context, 'stock_locations').select('*').eq('active', true).order('name'),
    scoped(context, 'stock_bins').select('*').order('name'),
    scoped(context, 'stock_levels').select('*').eq('product_id', id),
    // Committed is a fact about open deals rather than about this form, so it
    // is read where it lives instead of being recomputed here.
    context.supabase.rpc('product_stock_summary', { p_product_id: id }),
    scoped(context, 'tags').select('*').order('name'),
    scoped(context, 'product_tags').select('tag_id').eq('product_id', id),
  ])

  const stockLevels = (levels ?? []) as StockLevelRow[]
  const totals = (summary ?? [])[0] as { committed: number } | undefined

  return (
    <>
      <PageHeader title={`Edit ${product.name}`} />
      <ProductForm
        action={updateProduct}
        product={product}
        customFields={(customFields ?? []) as CustomFieldDefinitionRow[]}
        fieldOptions={(fieldOptions ?? []) as FieldOptionRow[]}
        defaultCurrency={context.organization.default_currency}
        locations={(locations ?? []) as StockLocationRow[]}
        bins={(bins ?? []) as StockBinRow[]}
        stock={stockLevels.map((level) => ({
          location_id: level.location_id,
          bin_id: level.bin_id ?? '',
          quantity: String(level.quantity),
          reserved: String(level.reserved),
          note: level.note ?? '',
        }))}
        committed={Number(totals?.committed ?? 0)}
        tags={(tags ?? []) as TagRow[]}
        selectedTagIds={((productTags ?? []) as { tag_id: string }[]).map((row) => row.tag_id)}
        canManage={context.isAdmin}
        submitLabel="Save changes"
      />
    </>
  )
}
