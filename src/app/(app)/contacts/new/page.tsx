import { requireSession, scoped } from '@/lib/tenancy'
import type { CustomFieldDefinitionRow, FieldOptionRow, TagRow, UserRow } from '@/lib/database.types'
import { PageHeader } from '@/components/ui'

import { createContact } from '../actions'
import { ContactForm } from '../contact-form'

export const metadata = { title: 'New contact · FLO CRM' }

export default async function NewContactPage({
  searchParams,
}: {
  searchParams: Promise<{ company_id?: string }>
}) {
  // Prefills the picker when arriving from a company page.
  const { company_id: companyId } = await searchParams
  const context = await requireSession()

  const [
    { data: companies },
    { data: owners },
    { data: customFields },
    { data: fieldOptions },
    { data: tags },
  ] = await Promise.all([
    scoped(context, 'companies').select('id, name').order('name'),
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'contact').order('order'),
    scoped(context, 'field_options').select('*').order('order'),
    scoped(context, 'tags').select('*').order('name'),
  ])

  return (
    <>
      <PageHeader title="New contact" description="Leads and customers are both contacts — the lifecycle stage is what differs." />
      <ContactForm
        action={createContact}
        prefillCompanyId={companyId}
        companies={(companies ?? []) as { id: string; name: string }[]}
        owners={(owners ?? []) as UserRow[]}
        customFields={(customFields ?? []) as CustomFieldDefinitionRow[]}
        fieldOptions={(fieldOptions ?? []) as FieldOptionRow[]}
        tags={(tags ?? []) as TagRow[]}
        canManage={context.canManage}
        submitLabel="Create contact"
      />
    </>
  )
}
