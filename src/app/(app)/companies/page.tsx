import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import {
  applyFilter,
  fieldsFor,
  filterFromSearchParams,
  groupRowsNested,
  labelFromFields,
  parseFilterConfig,
} from '@/lib/filters'
import type {
  CompanyRow,
  CustomFieldDefinitionRow,
  FieldOptionRow,
  SavedFilterRow,
  TagRow,
  UserRow,
} from '@/lib/database.types'
import { companyFieldValues, findCompanyField } from '@/lib/company-fields'
import { optionsForField } from '@/lib/field-options'
import { placeNames, type Place } from '@/lib/geography'
import { BulkEdit, SelectAll, SelectRow } from '@/components/bulk-bar'
import { bulkFieldsFor } from '@/lib/bulk-edit'
import { FilterBar } from '@/components/filter-bar'
import { EmptyState, PageHeader, StatCard, StatGrid, SubGroupRow } from '@/components/ui'
import { CustomCell, Empty, OptionBadge, OptionBadges, optionColor } from '@/components/contact-cards'
import { columnCatalogue, resolveColumns } from '@/lib/table-columns'
import { ColumnPicker } from '@/components/column-picker'
import { formatDay } from '@/lib/format'
import { AlertIcon, AwardIcon, CompaniesIcon, TrendingUpIcon } from '@/components/icons'

import { readColumns } from '../column-actions'

import { deleteSavedFilter, saveFilter } from '../contacts/actions'

/*
 * Never served from the route cache.
 *
 * These read per-request, per-tenant data behind an authenticated session, and
 * the App Router will happily hand back a previously rendered page otherwise —
 * which shows up as a deploy that went out and a screen that did not change.
 * The sales and invoice screens have said this since they were written; the
 * rest of the record pages were relying on it not happening.
 */
export const dynamic = 'force-dynamic'

export const metadata = { title: 'Companies · FLO CRM' }

/** Filter conditions travel in the URL as a JSON `f` param (see filterToSearchParams). */
const UNASSIGNED_VIEW = `/companies?f=${encodeURIComponent(
  JSON.stringify([{ field: 'owner_id', operator: 'is_empty', value: '' }]),
)}`

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const context = await requireSession()

  // Headline counts describe the whole book of companies, not the filtered
  // view, so they stay put while somebody narrows the list below — the same
  // rule the contacts list follows. Started here and awaited after the list
  // query so everything runs concurrently.
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)

  const live = () => scoped(context, 'companies').select('id', { count: 'exact', head: true }).is('deleted_at', null)

  /*
   * "Customer" has no column of its own the way a contact's lifecycle stage
   * does — a company counts if either half is true: one of its contacts is a
   * Customer, or the company has actually transacted (a won deal, or a sales
   * order/invoice that got past draft). Four id lists, unioned in memory
   * rather than one query, because that OR spans three unrelated tables and
   * PostgREST has no way to ask for it in one round trip.
   */
  const customerSignals = Promise.all([
    scoped(context, 'contacts')
      .select('company_id')
      .eq('lifecycle_stage', 'customer')
      .not('company_id', 'is', null),
    scoped(context, 'deals').select('company_id').eq('status', 'won').not('company_id', 'is', null),
    // Reserved and past: draft is a working order, and cancelled never happened.
    scoped(context, 'sales_orders')
      .select('company_id')
      .in('status', ['reserved', 'confirmed', 'fulfilled'])
      .not('company_id', 'is', null),
    // Sent and past: draft has not gone out, and void never happened either.
    scoped(context, 'invoices')
      .select('company_id')
      .in('status', ['sent', 'partial', 'paid'])
      .not('company_id', 'is', null),
  ])

  const statsPromise = Promise.all([
    live(),
    live().gte('created_at', monthStart.toISOString()),
    live().is('owner_id', null),
  ])

  const [
    { data: savedFilters },
    { data: customFields },
    { data: owners },
    { data: fieldOptions },
    { data: countryRows },
    { data: tagRows },
    { data: companyTagRows },
  ] = await Promise.all([
    scoped(context, 'saved_filters').select('*').eq('entity_type', 'company'),
    scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'company'),
    scoped(context, 'users').select('*').order('name'),
    scoped(context, 'field_options').select('*').order('order'),
    /*
     * Reference data, not tenant data. based_in and the territories store
     * codes, so without these the list reads "CA" where it means Canada — in
     * the cells, and in a group heading, which is worse.
     */
    context.supabase
      .from('countries')
      .select('code, name, kind')
      .order('sort_order')
      .order('name'),
    /*
     * Both halves of the join, once for the page. An embed on the company query
     * would fetch it on every request whether the Tags column is showing or
     * not; these two are small and only cost the page that asked.
     */
    scoped(context, 'tags').select('id, name, color').order('name'),
    scoped(context, 'company_tags').select('company_id, tag_id'),
  ])

  const places = placeNames((countryRows ?? []) as Place[])

  const allOptions = (fieldOptions ?? []) as FieldOptionRow[]

  /*
   * Scoped by entity, not just by key. `priority` is a list on companies,
   * another on contacts and another on products; matching the key alone drew
   * all three, and the colour a badge got depended on which came back first.
   */
  const marketOptions = optionsForField(allOptions, 'company', 'specialty_market')
  const typeOptions = optionsForField(allOptions, 'company', 'customer_type')
  const priorityOptions = optionsForField(allOptions, 'company', 'priority')

  /*
   * Region and size are the organization's own fields, so the columns look them
   * up by name. See findCompanyField for how forgiving that match is and why.
   */
  const definitions = (customFields ?? []) as CustomFieldDefinitionRow[]
  const regionField = findCompanyField(definitions, 'regions', 'region')
  const sizeField = findCompanyField(definitions, 'size')

  /** The same lookup, for a field found by name rather than named in code. */
  const customFieldOptions = (field: CustomFieldDefinitionRow | undefined) =>
    field ? optionsForField(allOptions, 'company', field.key) : []

  const regionOptions = customFieldOptions(regionField)
  const sizeOptions = customFieldOptions(sizeField)

  const viewId = typeof params.view === 'string' ? params.view : null
  const savedView = viewId
    ? ((savedFilters ?? []) as SavedFilterRow[]).find((filter) => filter.id === viewId)
    : undefined
  const config = savedView ? parseFilterConfig(savedView.filter_json) : filterFromSearchParams(params)

  const ownerList = (owners ?? []) as UserRow[]
  /*
   * Owners are uuids and the geography fields are codes, so all four have to be
   * offered as a list — a free-text condition on `based_in` wants "CA", which
   * nobody would guess, and typing "Canada" quietly matches nothing.
   */
  const fields = fieldsFor('company', definitions, allOptions).map((field) => {
    if (field.key === 'owner_id') {
      return { ...field, options: ownerList.map((u) => ({ value: u.id, label: u.name || u.email })) }
    }
    if (field.key === 'based_in' || field.key === 'sells_in') {
      return { ...field, options: places.countryOptions }
    }
    return field
  })

  let query = scoped(context, 'companies')
    .select('*, contacts(count)', { count: 'exact' })
    .is('deleted_at', null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = applyFilter(query as any, config, 'company') as any

  const { data, count } = await query.limit(200)
  const [totalStat, newThisMonth, unassigned] = await statsPromise
  const customerRows = await customerSignals
  const customers = new Set(
    customerRows.flatMap(({ data: rows }) =>
      ((rows ?? []) as { company_id: string }[]).map((row) => row.company_id),
    ),
  ).size
  const savedColumns = await readColumns('company')
  const rows = (data ?? []) as (CompanyRow & { contacts: { count: number }[] })[]

  const ownerNames = new Map(ownerList.map((user) => [user.id, user.name || user.email]))

  /* Tag ids to the tag, and each company to the tags on it. */
  const tagsById = new Map(
    ((tagRows ?? []) as Pick<TagRow, 'id' | 'name' | 'color'>[]).map((tag) => [tag.id, tag]),
  )
  const tagsByCompany = new Map<string, Pick<TagRow, 'id' | 'name' | 'color'>[]>()
  for (const link of (companyTagRows ?? []) as { company_id: string; tag_id: string }[]) {
    const tag = tagsById.get(link.tag_id)
    if (!tag) continue
    const list = tagsByCompany.get(link.company_id)
    if (list) list.push(tag)
    else tagsByCompany.set(link.company_id, [tag])
  }

  const bulkFields = bulkFieldsFor('company', {
    owners: ownerList.map((user) => ({ value: user.id, label: user.name || user.email })),
    customFields: definitions,
    fieldOptions: allOptions,
  })
  // The field is passed in because two of them can be grouped on at once, and
  // only one of them holds user ids.
  const groups = groupRowsNested(rows, config.groupBy, config.subGroupBy, labelFromFields(fields))

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
      case 'tags': {
        /*
         * The tag's own colour, which an admin chose in Settings → Tags, so it
         * is an inline style rather than a class — Tailwind cannot see a hex
         * that only exists in the database.
         */
        const tags = tagsByCompany.get(company.id) ?? []
        if (tags.length === 0) return <Empty />
        return (
          <span className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag.id}
                className="badge"
                style={{ backgroundColor: `${tag.color}1f`, color: tag.color }}
              >
                {tag.name}
              </span>
            ))}
          </span>
        )
      }
      case 'contacts':
        return <span className="text-slate-600">{company.contacts?.[0]?.count ?? 0}</span>
      case 'size':
        return <OptionBadges values={companyFieldValues(company, sizeField)} options={sizeOptions} />
      case 'region':
        return (
          <OptionBadges values={companyFieldValues(company, regionField)} options={regionOptions} />
        )
      // Codes in the column, names on the screen. See src/lib/geography.ts.
      case 'based_in':
        return company.based_in ? (
          <span className="text-slate-600">{places.country(company.based_in)}</span>
        ) : (
          <Empty />
        )
      case 'sells_in':
        return company.sells_in?.length ? (
          <span className="block truncate text-slate-600">
            {company.sells_in.map((code) => places.country(code)).join(', ')}
          </span>
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

      <StatGrid>
        <StatCard
          label="Total companies"
          value={String(totalStat.count ?? 0)}
          icon={CompaniesIcon}
          tone="blue"
        />
        <StatCard
          label="New this month"
          value={String(newThisMonth.count ?? 0)}
          icon={TrendingUpIcon}
          tone="brand"
          trend={
            (newThisMonth.count ?? 0) > 0
              ? { label: `+${newThisMonth.count}`, direction: 'up' }
              : undefined
          }
        />
        <StatCard label="Customers" value={String(customers)} icon={AwardIcon} tone="amber" />
        <StatCard
          label="Unassigned"
          value={String(unassigned.count ?? 0)}
          icon={AlertIcon}
          tone={(unassigned.count ?? 0) > 0 ? 'red' : 'violet'}
          href={(unassigned.count ?? 0) > 0 ? UNASSIGNED_VIEW : undefined}
        />
      </StatGrid>

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
          <div className="space-y-8">
            {groups.map((group) => (
            <div key={group.key ?? 'all'}>
              {config.groupBy && (
                <div className="group-header flex items-baseline justify-between gap-3">
                  <h2>{group.label}</h2>
                  <span className="badge bg-brand-100 text-brand-700">{group.rows.length}</span>
                </div>
              )}
              {/*
                The card starts here rather than around the heading, so the
                rounded corners land on the column header row, and overflow-x
                is what makes the radius clip that row's fill.
              */}
              <div className="group-panel overflow-x-auto">
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
            </div>
            ))}
          </div>
        </BulkEdit>
      )}
    </>
  )
}
