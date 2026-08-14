import { requireSession, scoped } from '@/lib/tenancy'
import type { CustomFieldDefinitionRow, FieldOptionRow, UserRow } from '@/lib/database.types'
import { PageHeader } from '@/components/ui'

import { createCompany } from '../actions'
import { CompanyForm } from '../company-form'

export const metadata = { title: 'New company · FLO CRM' }

export default async function NewCompanyPage() {
  const context = await requireSession()

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
      <PageHeader title="New company" />
      <CompanyForm
        action={createCompany}
        owners={(owners ?? []) as UserRow[]}
        customFields={(customFields ?? []) as CustomFieldDefinitionRow[]}
        fieldOptions={(fieldOptions ?? []) as FieldOptionRow[]}
        countries={(countries ?? []) as { code: string; name: string }[]}
        subdivisions={
          (subdivisions ?? []) as { code: string; country_code: string; name: string }[]
        }
        submitLabel="Create company"
      />
    </>
  )
}
