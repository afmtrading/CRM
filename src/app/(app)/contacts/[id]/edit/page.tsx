import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import type { ContactRow, CustomFieldDefinitionRow, FieldOptionRow, UserRow } from '@/lib/database.types'
import { contactName } from '@/lib/format'
import { PageHeader } from '@/components/ui'

import { updateContact } from '../../actions'
import { ContactForm } from '../../contact-form'

export default async function EditContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const contact = await firstRow<ContactRow>(
    scoped(context, 'contacts').select('*').eq('id', id).maybeSingle(),
  )

  if (!contact) notFound()

  const [
    { data: companies },
    { data: owners },
    { data: customFields },
    { data: fieldOptions },
    { data: products },
    { data: interest },
  ] = await Promise.all([
    scoped(context, 'companies').select('id, name').order('name'),
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'contact').order('order'),
    scoped(context, 'field_options').select('*').order('order'),
    scoped(context, 'products')
      .select('id, name')
      .is('deleted_at', null)
      .eq('active', true)
      .order('name'),
    scoped(context, 'contact_products').select('product_id').eq('contact_id', id),
  ])

  return (
    <>
      <PageHeader title={`Edit ${contactName(contact)}`} />
      <ContactForm
        action={updateContact}
        contact={contact}
        companies={(companies ?? []) as { id: string; name: string }[]}
        owners={(owners ?? []) as UserRow[]}
        customFields={(customFields ?? []) as CustomFieldDefinitionRow[]}
        fieldOptions={(fieldOptions ?? []) as FieldOptionRow[]}
        products={(products ?? []) as { id: string; name: string }[]}
        productInterest={((interest ?? []) as { product_id: string }[]).map((row) => row.product_id)}
        canManage={context.canManage}
        submitLabel="Save changes"
      />
    </>
  )
}
