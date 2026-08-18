import { redirect } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import type {
  CustomFieldDefinitionRow,
  FieldOptionRow,
  StockBinRow,
  StockLocationRow,
  TagRow,
} from '@/lib/database.types'
import { PageHeader } from '@/components/ui'

import { createProduct } from '../actions'
import { ProductForm } from '../product-form'

export const metadata = { title: 'New product · FLO CRM' }

export default async function NewProductPage() {
  const context = await requireSession()
  // The catalogue is configuration, not a rep's working data.
  if (!context.canManage) redirect('/products?error=permission')

  const [
    { data: customFields },
    { data: fieldOptions },
    { data: locations },
    { data: bins },
    { data: tags },
  ] = await Promise.all([
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'product').order('order'),
    scoped(context, 'field_options').select('*').order('order'),
    // Retired warehouses are left out of the picker: stock can still be read
    // out of one, but nothing new should be counted into it.
    scoped(context, 'stock_locations').select('*').eq('active', true).order('name'),
    scoped(context, 'stock_bins').select('*').order('name'),
    scoped(context, 'tags').select('*').order('name'),
  ])


  return (
    <>
      <PageHeader title="New product" />
      <ProductForm
        action={createProduct}
        customFields={(customFields ?? []) as CustomFieldDefinitionRow[]}
        fieldOptions={(fieldOptions ?? []) as FieldOptionRow[]}
        defaultCurrency={context.organization.default_currency}
        locations={(locations ?? []) as StockLocationRow[]}
        bins={(bins ?? []) as StockBinRow[]}
        stock={[]}
        tags={(tags ?? []) as TagRow[]}
        canManage={context.isAdmin}
        submitLabel="Create product"
      />
    </>
  )
}
