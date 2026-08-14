import { requireBulk } from '@/lib/tenancy'
import { PageHeader } from '@/components/ui'

import { ImportBuyers } from './import-buyers'

export const metadata = { title: 'Import a buyer list · FLO CRM' }

export default async function ImportBuyersPage() {
  // The same capability that governs the plain importer and export.
  await requireBulk()

  return (
    <>
      <PageHeader
        title="Import a buyer list"
        description="For a contact list with the company repeated down the rows — the shape a bought or blended list usually arrives in. It groups the rows into companies, works out which ones you already have, and shows you every change before writing anything."
      />
      <ImportBuyers />
    </>
  )
}
