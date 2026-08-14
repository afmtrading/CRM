import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import type { CompanyRow, CustomFieldDefinitionRow, FieldOptionRow, UserRow } from '@/lib/database.types'
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

  const [
    { data: owners },
    { data: customFields },
    { data: fieldOptions },
    { data: countries },
    { data: subdivisions },
  ] = await Promise.all([
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'company').order('order'),
    scoped(context, 'field_options').select('*').order('order'),
    // Reference data, not tenant data — no organization to scope it to, and
    // the same list for everybody.
    context.supabase.from('countries').select('code, name').order('name'),
    context.supabase.from('country_subdivisions').select('code, country_code, name').order('name'),
  ])

  return (
    <>
      <PageHeader title={`Edit ${company.name}`} />
      <CompanyForm
        action={updateCompany}
        company={company}
        owners={(owners ?? []) as UserRow[]}
        customFields={(customFields ?? []) as CustomFieldDefinitionRow[]}
        fieldOptions={(fieldOptions ?? []) as FieldOptionRow[]}
        countries={(countries ?? []) as { code: string; name: string }[]}
        subdivisions={
          (subdivisions ?? []) as { code: string; country_code: string; name: string }[]
        }
        submitLabel="Save changes"
      />
    </>
  )
}
