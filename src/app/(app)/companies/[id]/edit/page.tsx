import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import type { CompanyRow, CustomFieldDefinitionRow, UserRow } from '@/lib/database.types'
import { PageHeader } from '@/components/ui'

import { updateCompany } from '../../actions'
import { CompanyForm } from '../../company-form'

export default async function EditCompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const company = await firstRow<CompanyRow>(
    scoped(context, 'companies').select('*').eq('id', id).maybeSingle(),
  )

  if (!company) notFound()

  const [{ data: owners }, { data: customFields }] = await Promise.all([
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'company').order('order'),
  ])

  return (
    <>
      <PageHeader title={`Edit ${company.name}`} />
      <CompanyForm
        action={updateCompany}
        company={company}
        owners={(owners ?? []) as UserRow[]}
        customFields={(customFields ?? []) as CustomFieldDefinitionRow[]}
        submitLabel="Save changes"
      />
    </>
  )
}
