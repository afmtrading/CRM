import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { applyFilter, fieldsFor, filterFromSearchParams, groupRowsNested, parseFilterConfig } from '@/lib/filters'
import type {
  CompanyRow,
  CustomFieldDefinitionRow,
  FieldOptionRow,
  SavedFilterRow,
  UserRow,
} from '@/lib/database.types'
import { companyFieldValues, findCompanyField } from '@/lib/company-fields'
import { BulkEdit, SelectAll, SelectRow } from '@/components/bulk-bar'
import { bulkFieldsFor } from '@/lib/bulk-edit'
import { FilterBar } from '@/components/filter-bar'
import { EmptyState, PageHeader, SubGroupRow } from '@/components/ui'
import { CustomCell, Empty, OptionBadge, OptionBadges, optionColor } from '@/components/contact-cards'
import { columnCatalogue, resolveColumns } from '@/lib/table-columns'
import { ColumnPicker } from '@/components/column-picker'
import { formatDay } from '@/lib/format'

import { readColumns } from '../column-actions'

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
  const priorityOptions = allOptions.filter((option) => option.field_key === 'priority')

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
  const savedColumns = await readColumns('company')
  const rows = (data ?? []) as (CompanyRow & { contacts: { count: number }[] })[]

  const ownerNames = new Map(ownerList.map((user) => [user.id, user.name || user.email]))

  const bulkFields = bulkFieldsFor('company', {
    owners: ownerList.map((user) => ({ value: user.id, label: user.name || user.email })),
    customFields: definitions,
    fieldOptions: allOptions,
  })
  // The field is passed in because two of them can be grouped on at once, and
  // only one of them holds user ids.
  const groups = groupRowsNested(rows, config.groupBy, config.subGroupBy, (field, value) => {
    if (value === null) return 'None'
    if (field === 'owner_id') return ownerNames.get(value) ?? 'Unknown user'
    return value
  })

  const catalogue = columnCatalogue('company', definitions)
  const columns = resolveColumns('company', savedColumns, catalogue)

  // The checkbox, plus whatever was chosen. Companies have no actions cell.
  const COLUMNS = columns.length + 1

  const cell = (company: (typeof rows)[number], key: string): React.ReactNode => {
    switch (key) {
      case 'name':
        return (
          <Link
            href={`/companies/${company.id}`}
            className="block truncate font-medium text-slate-900 hover:text-brand-700"
          >
            {company.name}
          </Link>
        )
      case 'priority':
        return company.priority ? (
          <OptionBadge
            value={company.priority}
            color={optionColor(priorityOptions, company.priority)}
          />
        ) : (
          <Empty />
        )
      case 'customer_type':
        return company.customer_type?.length ? (
          <OptionBadges values={company.customer_type} options={typeOptions} />
        ) : (
          <Empty />
        )
      case 'specialty_market':
        return <OptionBadges values={company.specialty_market} options={marketOptions} />
      case 'stock_type':
        return company.stock_type?.length ? (
          <span className="block truncate text-slate-600">{company.stock_type.join(', ')}</span>
        ) : (
          <Empty />
        )
      case 'owner':
        return company.owner_id ? (
          <span className="text-slate-600">{ownerNames.get(company.owner_id) ?? '—'}</span>
        ) : (
          <Empty />
        )
      case 'contacts':
        return <span className="text-slate-600">{company.contacts?.[0]?.count ?? 0}</span>
      case 'size':
        return <OptionBadges values={companyFieldValues(company, sizeField)} options={sizeOptions} />
      case 'region':
        return (
          <OptionBadges values={companyFieldValues(company, regionField)} options={regionOptions} />
        )
      case 'based_in':
        return company.based_in ? (
          <span className="text-slate-600">{company.based_in}</span>
        ) : (
          <Empty />
        )
      case 'based_in_region':
        return company.based_in_region ? (
          <span className="text-slate-600">{company.based_in_region}</span>
        ) : (
          <Empty />
        )
      case 'sells_in':
        return company.sells_in?.length ? (
          <span className="block truncate text-slate-600">{company.sells_in.join(', ')}</span>
        ) : (
          <Empty />
        )
      case 'sources_in':
        return company.sources_in?.length ? (
          <span className="block truncate text-slate-600">{company.sources_in.join(', ')}</span>
        ) : (
          <Empty />
        )
      case 'industry':
        return company.industry ? (
          <span className="block truncate text-slate-600">{company.industry}</span>
        ) : (
          <Empty />
        )
      case 'domain':
        return company.domain ? (
          <a
            href={company.domain.startsWith('http') ? company.domain : `https://${company.domain}`}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-brand-700 hover:underline"
          >
            {company.domain}
          </a>
        ) : (
          <Empty />
        )
      case 'email':
        return company.email ? (
          <a href={`mailto:${company.email}`} className="block truncate text-brand-700 hover:underline">
            {company.email}
          </a>
        ) : (
          <Empty />
        )
      case 'phone':
        return company.phone ? (
          <span className="whitespace-nowrap text-slate-600">{company.phone}</span>
        ) : (
          <Empty />
        )
      case 'created_at':
        return <span className="text-slate-600">{formatDay(company.created_at)}</span>
      default:
        return <CustomCell row={company} columnKey={key} />
    }
  }

  const companyRow = (company: (typeof rows)[number]) => (
    <tr key={company.id} className="transition-colors hover:bg-slate-50/70">
      <td>
        <SelectRow id={company.id} label={`Select ${company.name}`} />
      </td>
      {columns.map((column) => (
        <td key={column.key} className={column.align === 'right' ? 'text-right' : undefined}>
          <div className="min-w-0 max-w-xs">{cell(company, column.key)}</div>
        </td>
      ))}
    </tr>
  )

  return (
    <>
      <PageHeader
        title="Companies"
        description={count ? `${count} compan${count === 1 ? 'y' : 'ies'}` : undefined}
        actions={
          <>
            <ColumnPicker
              entity="company"
              catalogue={catalogue}
              selected={columns.map((column) => column.key)}
            />
            {context.canWrite && (
              <Link href="/companies/new" className="btn-primary">
                New company
              </Link>
            )}
          </>
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
        <BulkEdit entity="company" fields={bulkFields} canDelete={context.canDelete}>
          <div className="space-y-6">
            {groups.map((group) => (
            <div key={group.key ?? 'all'} className="card overflow-hidden">
              {config.groupBy && (
                <div className="group-header flex items-center justify-between">
                  <h2 className="text-sm font-semibold">{group.label}</h2>
                  <span className="badge bg-white/25 text-white">{group.rows.length}</span>
                </div>
              )}
              <table className="table">
                <thead>
                  {/*
                    Whatever this person chose, in their order. The defaults
                    say what kind of business it is rather than when it was
                    typed in; anything else in the catalogue — website, the
                    territories, the dates — is a tick away in Columns.
                  */}
                  <tr>
                    <th className="w-10">
                      <SelectAll label="Select every company shown" />
                    </th>
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        className={column.align === 'right' ? 'text-right' : undefined}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(group.subGroups ?? [{ key: null, label: '', rows: group.rows }]).flatMap(
                    (sub) => [
                      ...(group.subGroups
                        ? [
                            <SubGroupRow
                              key={`sub-${sub.key ?? 'none'}`}
                              label={sub.label}
                              count={sub.rows.length}
                              columns={COLUMNS}
                            />,
                          ]
                        : []),
                      ...sub.rows.map(companyRow),
                    ],
                  )}
                </tbody>
              </table>
            </div>
            ))}
          </div>
        </BulkEdit>
      )}
    </>
  )
}
