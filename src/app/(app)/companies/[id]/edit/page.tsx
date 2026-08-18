import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import type {
  CompanyRow,
  CustomFieldDefinitionRow,
  FieldOptionRow,
  TagRow,
  UserRow,
} from '@/lib/database.types'
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
    { data: tags },
    { data: companyTags },
  ] = await Promise.all([
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'company').order('order'),
    scoped(context, 'field_options').select('*').order('order'),
    // Reference data, not tenant data — no organization to scope it to, and
    // the same list for everybody.
    context.supabase.from('countries').select('code, name, kind').order('sort_order').order('name'),
    scoped(context, 'tags').select('*').order('name'),
    scoped(context, 'company_tags').select('tag_id').eq('company_id', id),
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
        countries={(countries ?? []) as { code: string; name: string; kind?: string }[]}
        tags={(tags ?? []) as TagRow[]}
        selectedTagIds={((companyTags ?? []) as { tag_id: string }[]).map((row) => row.tag_id)}
        canManage={context.isAdmin}
        submitLabel="Save changes"
      />
    </>
  )
}
