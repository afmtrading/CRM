import { notFound, redirect } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import type { CustomFieldDefinitionRow, FieldOptionRow, ProductRow } from '@/lib/database.types'
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

  const [{ data: customFields }, { data: fieldOptions }] = await Promise.all([
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'product').order('order'),
    scoped(context, 'field_options').select('*').order('order'),
  ])

  return (
    <>
      <PageHeader title={`Edit ${product.name}`} />
      <ProductForm
        action={updateProduct}
        product={product}
        customFields={(customFields ?? []) as CustomFieldDefinitionRow[]}
        fieldOptions={(fieldOptions ?? []) as FieldOptionRow[]}
        defaultCurrency={context.organization.default_currency}
        submitLabel="Save changes"
      />
    </>
  )
}
