import { requireBulk, scoped } from '@/lib/tenancy'
import { PageHeader } from '@/components/ui'

import { ImportBuyers } from './import-buyers'

export const metadata = { title: 'Import a buyer list · FLO CRM' }

export default async function ImportBuyersPage() {
  // The same capability that governs the plain importer and export.
  const context = await requireBulk()

  /*
   * The organization's own fields, so the mapping step can offer them.
   *
   * The plain importer has offered custom fields since it was written; this
   * screen never did, which made it the more capable importer that could not
   * reach a field somebody had defined themselves.
   */
  const { data: definitions } = await scoped(context, 'custom_field_definitions')
    .select('key, label, entity_type')
    .order('order')

  return (
    <>
      <PageHeader
        title="Import a buyer list"
        description="For a contact list with the company repeated down the rows — the shape a bought or blended list usually arrives in. It groups the rows into companies, works out which ones you already have, and shows you every change before writing anything."
      />
      <ImportBuyers
        customFields={(definitions ?? []) as { key: string; label: string; entity_type: string }[]}
      />
    </>
  )
}
