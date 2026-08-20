import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import {
  applyFilter,
  fieldsFor,
  filterFromSearchParams,
  groupRowsNested,
  overlappingGroupField,
  labelFromFields,
  parseFilterConfig,
  TAGS_FIELD_KEY,
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
import { chosenValues } from '@/lib/custom-fields'
import { startOfMonthIn } from '@/lib/timezone'
import { placeNames, type Place } from '@/lib/geography'
import { BulkEdit, SelectAll, SelectRow } from '@/components/bulk-bar'
import { bulkFieldsFor } from '@/lib/bulk-edit'
import { FilterBar } from '@/components/filter-bar'
import {
  EmptyState,
  GroupOverlapNote,
  PageHeader,
  StatCard,
  StatGrid,
} from '@/components/ui'
import { CollapsibleGroup, CollapsibleSubGroup } from '@/components/collapsible'
import { InlineEdit, InlineText, type InlineOption } from '@/components/inline-edit'
import { CustomCell, Empty, OptionBadges, ReachActions } from '@/components/contact-cards'
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
  //
  // The month begins on the organization's clock. The server runs in UTC, so a
  // company added at nine on the evening of the 31st in Toronto had already
  // been counted against the following month.
  const monthStart = startOfMonthIn(context.organization.timezone)

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

  /*
   * A field's option list, in the shape an editable cell wants: the value, the
   * word to show for it, and the colour an admin gave it in Settings → Fields,
   * so the menu offers exactly the badges the column is already drawing.
   *
   * Scoped by entity, not just by key. `priority` is a list on companies,
   * another on contacts and another on products; matching the key alone drew
   * all three, and the colour a badge got depended on which came back first.
   *
   * Built once per field and handed to every row that shows it. React writes
   * an object it has already written as a back-reference, so one shared array
   * costs one copy in the payload while a fresh array per row costs one per
   * row — which is why this is cached rather than mapped inside the cell.
   */
  const inlineOptionCache = new Map<string, InlineOption[]>()
  const inlineOptions = (key: string): InlineOption[] => {
    const built = inlineOptionCache.get(key)
    if (built) return built

    const options = optionsForField(allOptions, 'company', key).map((option) => ({
      value: option.value,
      label: option.value,
      color: option.color,
    }))
    inlineOptionCache.set(key, options)
    return options
  }

  /*
   * Which cells can be changed from the list. Ownership is a manager's
   * decision wherever it is made; everything else follows plain write access.
   * The database checks both again — this only decides what is offered.
   */
  const canEditCell = context.canWrite
  const canAssign = context.canManage

  const viewId = typeof params.view === 'string' ? params.view : null
  const savedView = viewId
    ? ((savedFilters ?? []) as SavedFilterRow[]).find((filter) => filter.id === viewId)
    : undefined
  const config = savedView ? parseFilterConfig(savedView.filter_json) : filterFromSearchParams(params)

  const ownerList = (owners ?? []) as UserRow[]

  /**
   * The people a record can be assigned to, built once and handed to every
   * row — see the note on inlineOptions above.
   */
  const ownerOptions: InlineOption[] = ownerList.map((user) => ({
    value: user.id,
    label: user.name || user.email,
  }))
  const tagList = (tagRows ?? []) as Pick<TagRow, 'id' | 'name' | 'color'>[]

  /*
   * Which tags each company carries, as ids, before the query is built. A tag
   * condition becomes a predicate on `id` and there is nothing to build it from
   * once the rows have already come back — see tagPredicate.
   */
  const tagIdsByCompany = new Map<string, string[]>()
  for (const link of (companyTagRows ?? []) as { company_id: string; tag_id: string }[]) {
    const list = tagIdsByCompany.get(link.company_id)
    if (list) list.push(link.tag_id)
    else tagIdsByCompany.set(link.company_id, [link.tag_id])
  }
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
    /*
     * Tags are offered by id and read by name. A saved view that named them
     * would stop matching the moment somebody renamed one in Settings.
     */
    if (field.key === TAGS_FIELD_KEY) {
      return { ...field, options: tagList.map((tag) => ({ value: tag.id, label: tag.name })) }
    }
    return field
  })

  let query = scoped(context, 'companies')
    .select('*, contacts(count)', { count: 'exact' })
    .is('deleted_at', null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = applyFilter(query as any, config, 'company', undefined, tagIdsByCompany) as any

  const { data } = await query.limit(200)
  const [totalStat, newThisMonth, unassigned] = await statsPromise
  const customerRows = await customerSignals
  const customers = new Set(
    customerRows.flatMap(({ data: rows }) =>
      ((rows ?? []) as { company_id: string }[]).map((row) => row.company_id),
    ),
  ).size
  const savedColumns = await readColumns('company')
  /*
   * Tags ride along on the row so the grouping can read them. They are not a
   * column, and groupRows has only the row to work from.
   */
  const rows = ((data ?? []) as (CompanyRow & { contacts: { count: number }[] })[]).map(
    (company) => ({ ...company, [TAGS_FIELD_KEY]: tagIdsByCompany.get(company.id) ?? [] }),
  )


  /*
   * The tags an organization has, as options. Their colours are hexes an admin
   * chose in Settings → Tags rather than one of the ten named ones, so they
   * ride as a swatch — see InlineOption. Which company carries which is
   * already `tagIdsByCompany`, built above for the filter.
   */
  const tagOptions: InlineOption[] = tagList.map((tag) => ({
    value: tag.id,
    label: tag.name,
    swatch: tag.color,
  }))

  const bulkFields = bulkFieldsFor('company', {
    owners: ownerList.map((user) => ({ value: user.id, label: user.name || user.email })),
    customFields: definitions,
    fieldOptions: allOptions,
  })
  // The field is passed in because two of them can be grouped on at once, and
  // only one of them holds user ids.
  // Tags put a record in every group it is tagged with, so the counts add up
  // to more than the list. The page says so rather than looking wrong.
  const overlap = overlappingGroupField(fields, config.groupBy, config.subGroupBy)

  const groups = groupRowsNested(rows, config.groupBy, config.subGroupBy, labelFromFields(fields))

  const catalogue = columnCatalogue('company', definitions)
  const columns = resolveColumns('company', savedColumns, catalogue)

  // Checkbox, the chosen columns, and the call/email icons at the end.
  const COLUMNS = columns.length + 2

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
      /*
       * From here down: the cell is the editor. Click it, pick a value, and it
       * is written — see components/inline-edit. The columns that offer this
       * are exactly the ones the database will accept a one-field change to,
       * which is why the name is still a link to the record rather than a box
       * to type in.
       */
      case 'priority':
        return (
          <InlineEdit
            entity="company"
            id={company.id}
            field="priority"
            fieldLabel="Priority"
            values={company.priority ? [company.priority] : []}
            options={inlineOptions('priority')}
            canEdit={canEditCell}
          />
        )
      case 'customer_type':
        return (
          <InlineEdit
            entity="company"
            id={company.id}
            field="customer_type"
            fieldLabel="Company type"
            values={company.customer_type ?? []}
            options={inlineOptions('customer_type')}
            multiple
            canEdit={canEditCell}
          />
        )
      case 'specialty_market':
        return (
          <InlineEdit
            entity="company"
            id={company.id}
            field="specialty_market"
            fieldLabel="Merchandise"
            values={company.specialty_market ?? []}
            options={inlineOptions('specialty_market')}
            multiple
            canEdit={canEditCell}
          />
        )
      case 'stock_type':
        return (
          <InlineEdit
            entity="company"
            id={company.id}
            field="stock_type"
            fieldLabel="Stock type"
            values={company.stock_type ?? []}
            options={inlineOptions('stock_type')}
            multiple
            canEdit={canEditCell}
          />
        )
      case 'owner':
        return (
          <InlineEdit
            entity="company"
            id={company.id}
            field="owner_id"
            fieldLabel="Owner"
            values={company.owner_id ? [company.owner_id] : []}
            options={ownerOptions}
            canEdit={canAssign}
          />
        )
      case 'tags':
        /*
         * The same menu the other vocabulary fields use, over a different
         * table: tags are a join rather than a column. Nobody reading a list
         * should have to know which of their record's words live where.
         */
        return (
          <InlineEdit
            as="tags"
            entity="company"
            id={company.id}
            field="tags"
            fieldLabel="Tags"
            values={tagIdsByCompany.get(company.id) ?? []}
            options={tagOptions}
            multiple
            canEdit={canEditCell}
          />
        )
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
        return (
          <InlineText
            entity="company"
            id={company.id}
            field="email"
            fieldLabel="Email"
            kind="email"
            value={company.email ?? ''}
            display={
              company.email ? (
                <span className="block truncate text-slate-600">{company.email}</span>
              ) : (
                <Empty />
              )
            }
            canEdit={canEditCell}
          />
        )
      case 'phone':
        return (
          <InlineText
            entity="company"
            id={company.id}
            field="phone"
            fieldLabel="Phone"
            kind="phone"
            value={company.phone ?? ''}
            display={
              company.phone ? (
                <span className="whitespace-nowrap text-slate-600">{company.phone}</span>
              ) : (
                <Empty />
              )
            }
            canEdit={canEditCell}
          />
        )
      case 'created_at':
        return <span className="text-slate-600">{formatDay(company.created_at)}</span>
      default: {
        /*
         * An organization's own fields. The ones with a list behind them are
         * editable in place like the built-in ones; a free-text or number
         * field is shown as it is stored, because there is nothing to pick
         * from and nothing here to validate a typed value against.
         */
        const definition = definitions.find(
          (candidate) => `custom_fields.${candidate.key}` === key,
        )

        if (
          definition &&
          (definition.field_type === 'select' || definition.field_type === 'multiselect')
        ) {
          return (
            <InlineEdit
              entity="company"
              id={company.id}
              field={key}
              fieldLabel={definition.label}
              values={chosenValues(company.custom_fields?.[definition.key])}
              options={inlineOptions(definition.key)}
              multiple={definition.field_type === 'multiselect'}
              canEdit={canEditCell}
            />
          )
        }

        return <CustomCell row={company} columnKey={key} />
      }
    }
  }

  const companyRow = (company: (typeof rows)[number]) => (
    <tr key={company.id} className="transition-colors hover:bg-slate-50/70">
      <td>
        <SelectRow id={company.id} label={`Select ${company.name}`} />
      </td>
      {/*
        The way to write to the address in the Email cell, now that the cell
        itself is the box for correcting it — and ahead of the name, where the
        horizontal scroll cannot hide it once somebody adds a few columns. The
        contacts list is arranged the same way, for the same reason.
      */}
      <td className="w-16">
        <ReachActions
          phone={company.phone}
          email={company.email}
          label={company.name}
          align="start"
        />
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
          {overlap && <GroupOverlapNote label={overlap.label} />}
          <div className="space-y-8">
            {groups.map((group) => (
            <CollapsibleGroup
              key={group.key ?? 'all'}
              scope="company"
              id={group.key ?? 'all'}
              /* No heading when the list is not grouped — and then nothing to fold. */
              label={config.groupBy ? group.label : undefined}
              summary={
                config.groupBy ? (
                  <span className="badge bg-brand-100 text-brand-700">{group.rows.length}</span>
                ) : undefined
              }
            >
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
                    {/* See the note on the cell: ahead of the name, where the
                        horizontal scroll cannot reach it. */}
                    <th className="w-16">Actions</th>
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
                  {group.subGroups
                    ? group.subGroups.map((sub) => (
                        <CollapsibleSubGroup
                          key={`sub-${sub.key ?? 'none'}`}
                          scope="company"
                          id={`${group.key ?? 'all'}/${sub.key ?? 'none'}`}
                          label={sub.label}
                          count={sub.rows.length}
                          columns={COLUMNS}
                        >
                          {sub.rows.map(companyRow)}
                        </CollapsibleSubGroup>
                      ))
                    : group.rows.map(companyRow)}
                </tbody>
              </table>
              </div>
            </CollapsibleGroup>
            ))}
          </div>
        </BulkEdit>
      )}
    </>
  )
}
