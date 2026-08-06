import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import {
  applyFilter,
  fieldsFor,
  filterFromSearchParams,
  groupRows,
  parseFilterConfig,
} from '@/lib/filters'
import { contactName, formatDate } from '@/lib/format'
import type {
  ContactRow,
  CompanyRow,
  CustomFieldDefinitionRow,
  SavedFilterRow,
  UserRow,
} from '@/lib/database.types'
import { FilterBar } from '@/components/filter-bar'
import { EmptyState, LifecycleBadge, PageHeader } from '@/components/ui'

import { deleteSavedFilter, saveFilter } from './actions'

export const metadata = { title: 'Contacts · FLO CRM' }

const PAGE_SIZE = 200

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const context = await requireSession()

  const [{ data: savedFilters }, { data: customFields }, { data: owners }, { data: companies }] =
    await Promise.all([
      scoped(context, 'saved_filters').select('*').eq('entity_type', 'contact'),
      scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'contact'),
      scoped(context, 'users').select('*').order('name'),
      scoped(context, 'companies').select('id, name').order('name'),
    ])

  // A ?view=<id> link replays a saved filter; anything else comes from the URL.
  const viewId = typeof params.view === 'string' ? params.view : null
  const savedView = viewId
    ? ((savedFilters ?? []) as SavedFilterRow[]).find((filter) => filter.id === viewId)
    : undefined

  const config = savedView
    ? parseFilterConfig(savedView.filter_json)
    : filterFromSearchParams(params)

  const ownerList = (owners ?? []) as UserRow[]
  const companyList = (companies ?? []) as Pick<CompanyRow, 'id' | 'name'>[]

  const fields = fieldsFor('contact', (customFields ?? []) as CustomFieldDefinitionRow[]).map(
    (field) => {
      if (field.key === 'owner_id') {
        return {
          ...field,
          options: ownerList.map((user) => ({ value: user.id, label: user.name || user.email })),
        }
      }
      if (field.key === 'company_id') {
        return {
          ...field,
          options: companyList.map((company) => ({ value: company.id, label: company.name })),
        }
      }
      return field
    },
  )

  let query = scoped(context, 'contacts')
    .select('*, companies(id, name)', { count: 'exact' })
    // Merged-away records stay in the table as tombstones; the list shows survivors.
    .is('duplicate_of_id', null)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = applyFilter(query as any, config, 'contact') as any

  const { data: contacts, count, error } = await query.limit(PAGE_SIZE)

  const rows = (contacts ?? []) as (ContactRow & { companies: { id: string; name: string } | null })[]

  const ownerNames = new Map(ownerList.map((user) => [user.id, user.name || user.email]))
  const companyNames = new Map(companyList.map((company) => [company.id, company.name]))

  const groups = groupRows(rows, config.groupBy, (value) => {
    if (value === null) return 'None'
    if (config.groupBy === 'owner_id') return ownerNames.get(value) ?? 'Unknown user'
    if (config.groupBy === 'company_id') return companyNames.get(value) ?? 'Unknown company'
    return value
  })

  return (
    <>
      <PageHeader
        title="Contacts"
        description={
          count !== null && count !== undefined
            ? `${count} contact${count === 1 ? '' : 's'}${count > PAGE_SIZE ? ` · showing first ${PAGE_SIZE}` : ''}`
            : undefined
        }
        actions={
          <Link href="/contacts/new" className="btn-primary">
            New contact
          </Link>
        }
      />

      <FilterBar
        fields={fields}
        initial={config}
        savedFilters={(savedFilters ?? []) as SavedFilterRow[]}
        entityType="contact"
        currentUserId={context.user.id}
        saveAction={saveFilter}
        deleteAction={deleteSavedFilter}
      />

      {error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error.message}
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No contacts match this view"
          description="Adjust the filters, or add a contact to get started."
          action={
            <Link href="/contacts/new" className="btn-primary">
              New contact
            </Link>
          }
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.key ?? 'all'} className="card overflow-hidden">
              {config.groupBy && (
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2">
                  <h2 className="text-sm font-semibold text-slate-800">{group.label}</h2>
                  <span className="text-xs text-slate-500">{group.rows.length}</span>
                </div>
              )}
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Company</th>
                    <th>Stage</th>
                    <th>Score</th>
                    <th>Owner</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((contact) => (
                    <tr key={contact.id} className="hover:bg-slate-50">
                      <td>
                        <Link
                          href={`/contacts/${contact.id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {contactName(contact)}
                        </Link>
                      </td>
                      <td className="text-slate-600">{contact.email ?? '—'}</td>
                      <td className="text-slate-600">{contact.phone ?? '—'}</td>
                      <td className="text-slate-600">
                        {contact.companies ? (
                          <Link
                            href={`/companies/${contact.companies.id}`}
                            className="hover:text-brand-700 hover:underline"
                          >
                            {contact.companies.name}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <LifecycleBadge stage={contact.lifecycle_stage} />
                      </td>
                      <td className="font-medium text-slate-700">{contact.lead_score}</td>
                      <td className="text-slate-600">
                        {contact.owner_id ? (ownerNames.get(contact.owner_id) ?? '—') : '—'}
                      </td>
                      <td className="text-slate-500">{formatDate(contact.created_at)}</td>
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
