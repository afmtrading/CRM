import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { applyFilter, fieldsFor, filterFromSearchParams, groupRows, parseFilterConfig } from '@/lib/filters'
import type {
  CompanyRow,
  CustomFieldDefinitionRow,
  FieldOptionRow,
  SavedFilterRow,
  UserRow,
} from '@/lib/database.types'
import { companyFieldValues, findCompanyField } from '@/lib/company-fields'
import { FilterBar } from '@/components/filter-bar'
import { EmptyState, PageHeader } from '@/components/ui'
import { OptionBadges } from '@/components/contact-cards'

import { deleteSavedFilter, saveFilter } from '../contacts/actions'

export const metadata = { title: 'Companies · FLO CRM' }

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const context = await requireSession()

  const [{ data: savedFilters }, { data: customFields }, { data: owners }, { data: fieldOptions }] =
    await Promise.all([
      scoped(context, 'saved_filters').select('*').eq('entity_type', 'company'),
      scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'company'),
      scoped(context, 'users').select('*').order('name'),
      scoped(context, 'field_options').select('*').order('order'),
    ])

  const allOptions = (fieldOptions ?? []) as FieldOptionRow[]

  const marketOptions = allOptions.filter((option) => option.field_key === 'specialty_market')
  const typeOptions = allOptions.filter((option) => option.field_key === 'customer_type')

  /*
   * Region and size are the organization's own fields, so the columns look them
   * up by name. See findCompanyField for how forgiving that match is and why.
   */
  const definitions = (customFields ?? []) as CustomFieldDefinitionRow[]
  const regionField = findCompanyField(definitions, 'regions', 'region')
  const sizeField = findCompanyField(definitions, 'size')

  const optionsForField = (field: CustomFieldDefinitionRow | undefined) =>
    field
      ? allOptions.filter(
          (option) => option.entity_type === 'company' && option.field_key === field.key,
        )
      : []

  const regionOptions = optionsForField(regionField)
  const sizeOptions = optionsForField(sizeField)

  const viewId = typeof params.view === 'string' ? params.view : null
  const savedView = viewId
    ? ((savedFilters ?? []) as SavedFilterRow[]).find((filter) => filter.id === viewId)
    : undefined
  const config = savedView ? parseFilterConfig(savedView.filter_json) : filterFromSearchParams(params)

  const ownerList = (owners ?? []) as UserRow[]
  const fields = fieldsFor('company', definitions, allOptions).map((field) =>
    field.key === 'owner_id'
      ? { ...field, options: ownerList.map((u) => ({ value: u.id, label: u.name || u.email })) }
      : field,
  )

  let query = scoped(context, 'companies')
    .select('*, contacts(count)', { count: 'exact' })
    .is('deleted_at', null)
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
          context.canWrite ? (
            <Link href="/companies/new" className="btn-primary">
              New company
            </Link>
          ) : undefined
        }
      />

      <FilterBar
        fields={fields}
        initial={config}
        savedFilters={(savedFilters ?? []) as SavedFilterRow[]}
        entityType="company"
        currentUserId={context.user.id}
        canExport={context.canBulk}
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
                  {/*
                    What kind of business it is, not when it was typed in. The
                    website left the row — it is one click away on the record
                    and was mostly empty here — and the company type came in
                    under the name, where it reads as part of naming it.
                  */}
                  <tr>
                    <th>Name</th>
                    <th>Market</th>
                    <th>Owner</th>
                    <th>Contacts</th>
                    <th>Size</th>
                    <th>Region</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((company) => (
                    <tr key={company.id} className="transition-colors hover:bg-slate-50/70">
                      <td>
                        <div className="min-w-0">
                          <Link
                            href={`/companies/${company.id}`}
                            className="block truncate font-medium text-slate-900 hover:text-brand-700"
                          >
                            {company.name}
                          </Link>
                          <div className="mt-1">
                            {company.customer_type?.length ? (
                              <OptionBadges
                                values={company.customer_type}
                                options={typeOptions}
                              />
                            ) : (
                              <span className="text-xs text-slate-400">No company type</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        <OptionBadges values={company.specialty_market} options={marketOptions} />
                      </td>
                      <td className="text-slate-600">
                        {company.owner_id ? (ownerNames.get(company.owner_id) ?? '—') : '—'}
                      </td>
                      <td className="text-slate-600">{company.contacts?.[0]?.count ?? 0}</td>
                      <td>
                        <OptionBadges
                          values={companyFieldValues(company, sizeField)}
                          options={sizeOptions}
                        />
                      </td>
                      <td>
                        <OptionBadges
                          values={companyFieldValues(company, regionField)}
                          options={regionOptions}
                        />
                      </td>
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
