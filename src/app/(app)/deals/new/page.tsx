import { requireSession, scoped } from '@/lib/tenancy'
import { contactName } from '@/lib/format'
import type {
  ContactRow,
  CustomFieldDefinitionRow,
  FieldOptionRow,
  PipelineRow,
  StageRow,
  UserRow,
} from '@/lib/database.types'
import { PageHeader } from '@/components/ui'

import { createDeal } from '../actions'
import { DealForm } from '../deal-form'

export const metadata = { title: 'New deal · FLO CRM' }

/**
 * What the currency field is pre-filled with.
 *
 * Not the organization's default currency, which still governs report totals —
 * this is only the starting value of a dropdown, and the desk trades in USD.
 */
const NEW_DEAL_CURRENCY = 'USD'

export default async function NewDealPage({
  searchParams,
}: {
  searchParams: Promise<{ contact_id?: string }>
}) {
  const { contact_id: contactId } = await searchParams
  const context = await requireSession()

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
    scoped(context, 'pipelines').select('*').order('name'),
    scoped(context, 'stages').select('*').order('order'),
    scoped(context, 'contacts')
      .select('id, first_name, last_name, email')
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
      <PageHeader title="New deal" />
      <DealForm
        action={createDeal}
        pipelines={(pipelines ?? []) as PipelineRow[]}
        stages={(stages ?? []) as StageRow[]}
        contacts={((contacts ?? []) as ContactRow[]).map((contact) => ({
          id: contact.id,
          label: contactName(contact),
        }))}
        companies={(companies ?? []) as { id: string; name: string }[]}
        owners={(owners ?? []) as UserRow[]}
        lossReasons={((reasons ?? []) as { value: string }[]).map((row) => row.value)}
        customFields={(definitions ?? []) as CustomFieldDefinitionRow[]}
        fieldOptions={(options ?? []) as FieldOptionRow[]}
        defaultCurrency={NEW_DEAL_CURRENCY}
        defaultContactId={contactId}
        submitLabel="Create deal"
      />
    </>
  )
}
