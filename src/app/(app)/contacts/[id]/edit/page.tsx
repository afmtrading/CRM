import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import type { ContactRow, CustomFieldDefinitionRow, UserRow } from '@/lib/database.types'
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

  const [{ data: companies }, { data: owners }, { data: customFields }] = await Promise.all([
    scoped(context, 'companies').select('id, name').order('name'),
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'contact').order('order'),
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
        submitLabel="Save changes"
      />
    </>
  )
}
