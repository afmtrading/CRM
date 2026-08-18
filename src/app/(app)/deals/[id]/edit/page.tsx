import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import { contactName } from '@/lib/format'
import type {
  ContactRow,
  CustomFieldDefinitionRow,
  DealRow,
  FieldOptionRow,
  PipelineRow,
  StageRow,
  UserRow,
} from '@/lib/database.types'
import { PageHeader } from '@/components/ui'

import { updateDeal } from '../../actions'
import { DealForm } from '../../deal-form'

export default async function EditDealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const deal = await firstRow<DealRow>(
    scoped(context, 'deals').select('*').eq('id', id).maybeSingle(),
  )
  if (!deal) notFound()

  const [
    { data: pipelines },
    { data: stages },
    { data: contacts },
    { data: companies },
    { data: owners },
    { data: reasons },
    { data: definitions },
    { data: options },
  ] = await Promise.all([
    /*
     * Retired ones are not offered. Safe to filter without losing the deal's
     * own stage: a pipeline cannot be retired while any deal is on the board in
     * it, and a deal restored from the recycle bin brings its stage back out
     * with it — see remove_pipeline() and restore_deal().
     */
    scoped(context, 'pipelines').select('*').is('archived_at', null).order('name'),
    scoped(context, 'stages').select('*').is('archived_at', null).order('order'),
    scoped(context, 'contacts')
      .select('id, first_name, last_name, email, company_id, companies(name)')
      .is('duplicate_of_id', null)
      .order('last_name')
      .limit(500),
    scoped(context, 'companies').select('id, name').order('name').limit(500),
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
    scoped(context, 'field_options')
      .select('value')
      .eq('entity_type', 'deal')
      .eq('field_key', 'loss_reason')
      .order('order'),
    scoped(context, 'custom_field_definitions')
      .select('*')
      .eq('entity_type', 'deal')
      .order('order'),
    // Every option row, not just the deal ones: a custom select on a deal draws
    // its values from the same table the built-in lists use.
    scoped(context, 'field_options').select('*').order('order'),
  ])

  return (
    <>
      <PageHeader title={`Edit ${deal.name}`} />
      <DealForm
        action={updateDeal}
        deal={deal}
        pipelines={(pipelines ?? []) as PipelineRow[]}
        stages={(stages ?? []) as StageRow[]}
        contacts={((contacts ?? []) as (ContactRow & { companies: { name: string } | null })[]).map(
          (contact) => ({
            id: contact.id,
            label: contactName(contact),
            companyId: contact.company_id,
            companyName: contact.companies?.name ?? null,
          }),
        )}
        companies={(companies ?? []) as { id: string; name: string }[]}
        owners={(owners ?? []) as UserRow[]}
        lossReasons={((reasons ?? []) as { value: string }[]).map((row) => row.value)}
        customFields={(definitions ?? []) as CustomFieldDefinitionRow[]}
        fieldOptions={(options ?? []) as FieldOptionRow[]}
        defaultCurrency={context.organization.default_currency}
        submitLabel="Save changes"
      />
    </>
  )
}
