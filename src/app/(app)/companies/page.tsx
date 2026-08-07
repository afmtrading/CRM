import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { applyFilter, fieldsFor, filterFromSearchParams, groupRows, parseFilterConfig } from '@/lib/filters'
import { formatDate } from '@/lib/format'
import type { CompanyRow, CustomFieldDefinitionRow, SavedFilterRow, UserRow } from '@/lib/database.types'
import { FilterBar } from '@/components/filter-bar'
import { Avatar, EmptyState, PageHeader } from '@/components/ui'

import { deleteSavedFilter, saveFilter } from '../contacts/actions'

export const metadata = { title: 'Companies · FLO CRM' }

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const context = await requireSession()

  const [{ data: savedFilters }, { data: customFields }, { data: owners }] = await Promise.all([
    scoped(context, 'saved_filters').select('*').eq('entity_type', 'company'),
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'company'),
    scoped(context, 'users').select('*').order('name'),
  ])

  const viewId = typeof params.view === 'string' ? params.view : null
  const savedView = viewId
    ? ((savedFilters ?? []) as SavedFilterRow[]).find((filter) => filter.id === viewId)
    : undefined
  const config = savedView ? parseFilterConfig(savedView.filter_json) : filterFromSearchParams(params)

  const ownerList = (owners ?? []) as UserRow[]
  const fields = fieldsFor('company', (customFields ?? []) as CustomFieldDefinitionRow[]).map((field) =>
    field.key === 'owner_id'
      ? { ...field, options: ownerList.map((u) => ({ value: u.id, label: u.name || u.email })) }
      : field,
  )

  let query = scoped(context, 'companies').select('*, contacts(count)', { count: 'exact' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = applyFilter(query as any, config, 'company') as any

  const { data, count } = await query.limit(200)
  const rows = (data ?? []) as (CompanyRow & { contacts: { count: number }[] })[]

  const ownerNames = new Map(ownerList.map((user) => [user.id, user.name || user.email]))
  const groups = groupRows(rows, config.groupBy, (value) => {
    if (value === null) return 'None'
    if (config.groupBy === 'owner_id') return ownerNames.get(value) ?? 'Unknown user'
    return value
  })

  return (
    <>
      <PageHeader
        title="Companies"
        description={count ? `${count} compan${count === 1 ? 'y' : 'ies'}` : undefined}
        actions={
          <Link href="/companies/new" className="btn-primary">
            New company
          </Link>
        }
      />

      <FilterBar
        fields={fields}
        initial={config}
        savedFilters={(savedFilters ?? []) as SavedFilterRow[]}
        entityType="company"
        currentUserId={context.user.id}
        saveAction={saveFilter}
        deleteAction={deleteSavedFilter}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No companies match this view"
          action={
            <Link href="/companies/new" className="btn-primary">
              New company
            </Link>
          }
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.key ?? 'all'} className="card overflow-hidden">
              {config.groupBy && (
                <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                  <h2 className="text-sm font-semibold text-slate-800">{group.label}</h2>
                  <span className="text-xs text-slate-500">{group.rows.length}</span>
                </div>
              )}
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Domain</th>
                    <th>Industry</th>
                    <th>Contacts</th>
                    <th>Owner</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((company) => (
                    <tr key={company.id} className="transition-colors hover:bg-slate-50/70">
                      <td>
                        <div className="flex items-center gap-3">
                          <Avatar name={company.name} className="h-9 w-9 rounded-xl" />
                          <Link
                            href={`/companies/${company.id}`}
                            className="font-medium text-slate-900 hover:text-brand-700"
                          >
                            {company.name}
                          </Link>
                        </div>
                      </td>
                      <td className="text-slate-600">{company.domain ?? '—'}</td>
                      <td className="text-slate-600">{company.industry ?? '—'}</td>
                      <td className="text-slate-600">{company.contacts?.[0]?.count ?? 0}</td>
                      <td className="text-slate-600">
                        {company.owner_id ? (ownerNames.get(company.owner_id) ?? '—') : '—'}
                      </td>
                      <td className="text-slate-500">{formatDate(company.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
