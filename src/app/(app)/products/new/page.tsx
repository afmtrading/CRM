import { redirect } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import type { CustomFieldDefinitionRow, FieldOptionRow } from '@/lib/database.types'
import { PageHeader } from '@/components/ui'

import { createProduct } from '../actions'
import { ProductForm } from '../product-form'

export const metadata = { title: 'New product · FLO CRM' }

export default async function NewProductPage() {
  const context = await requireSession()
  // The catalogue is configuration, not a rep's working data.
  if (!context.canManage) redirect('/products?error=permission')

  const [{ data: customFields }, { data: fieldOptions }] = await Promise.all([
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'product').order('order'),
    scoped(context, 'field_options').select('*').order('order'),
  ])

  return (
    <>
      <PageHeader title="New product" />
      <ProductForm
        action={createProduct}
        customFields={(customFields ?? []) as CustomFieldDefinitionRow[]}
        fieldOptions={(fieldOptions ?? []) as FieldOptionRow[]}
        defaultCurrency={context.organization.default_currency}
        submitLabel="Create product"
      />
    </>
  )
}
