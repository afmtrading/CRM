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
      <PageHeader title="Import a buyer list" />
      <ImportBuyers
        customFields={(definitions ?? []) as { key: string; label: string; entity_type: string }[]}
      />
    </>
  )
}
