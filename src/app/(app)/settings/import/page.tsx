import Link from 'next/link'

import { requireBulk, scoped } from '@/lib/tenancy'
import type { CustomFieldDefinitionRow, ImportJobRow } from '@/lib/database.types'
import { DateTime } from '@/components/date-time'
import { PageHeader, Section } from '@/components/ui'

import { ImportWizard } from './import-wizard'

export const metadata = { title: 'Import · FLO CRM' }

export default async function ImportPage() {
  const context = await requireBulk()

  const [{ data: customFields }, { data: jobs }] = await Promise.all([
    scoped(context, 'custom_field_definitions').select('*'),
    scoped(context, 'import_jobs').select('*').order('created_at', { ascending: false }).limit(10),
  ])

  const jobList = (jobs ?? []) as ImportJobRow[]

  return (
    <>
      <PageHeader
        title="Import data"
        description="Map your CSV columns, check the preview, then commit. Rows that fail are reported individually — the rest still import."
        actions={
          <>
            {/*
              A buyer list is a different shape from a plain contact CSV — the
              company repeats down the rows, and the columns need reading rather
              than mapping. It gets its own screen instead of options bolted
              onto this one.
            */}
            <Link href="/settings/import/companies" className="btn-secondary">
              Import a buyer list
            </Link>
            <Link href="/api/export?entity=contact" className="btn-secondary" prefetch={false}>
              Export contacts
            </Link>
          </>
        }
      />

      <ImportWizard customFields={(customFields ?? []) as CustomFieldDefinitionRow[]} />

      {jobList.length > 0 && (
        <div className="mt-6">
          <Section title="Recent imports">
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th className="text-right">Imported</th>
                  <th className="text-right">Failed</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {jobList.map((job) => (
                  <tr key={job.id}>
                    <td className="font-medium text-slate-800">{job.file_name || '—'}</td>
                    <td className="capitalize text-slate-600">{job.entity_type}</td>
                    <td className="text-slate-600">{job.status}</td>
                    <td className="text-right text-emerald-700">{job.rows_processed}</td>
                    <td className="text-right text-red-700">{job.rows_failed}</td>
                    <td className="text-slate-500">
                      <DateTime value={job.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </div>
      )}
    </>
  )
}
