import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatDay, formatPrice } from '@/lib/format'
import { MARKETPLACE_OPTION_FIELDS, directionLabel, yesNo } from '@/lib/marketplace'
import { columnCatalogue, resolveColumns } from '@/lib/table-columns'
import type {
  CompanyRow,
  CustomFieldDefinitionRow,
  FieldOptionRow,
  MarketplaceProfileRow,
  UserRow,
} from '@/lib/database.types'
import { ColumnPicker } from '@/components/column-picker'
import { CustomCell, Empty, OptionBadge, OptionBadges, optionColor } from '@/components/contact-cards'
import { EmptyState, PageHeader, StatCard, StatGrid, SubGroupRow } from '@/components/ui'
import { FilterBar } from '@/components/filter-bar'
import {
  MARKETPLACE_FIELDS,
  filterFromSearchParams,
  groupRowsNested,
  labelFromFields,
  matchesFilter,
  parseFilterConfig,
  sortRows,
} from '@/lib/filters'
import type { SavedFilterRow } from '@/lib/database.types'
import { placeNames, type Place } from '@/lib/geography'
import { LayersIcon, StoreIcon, TagIcon } from '@/components/icons'

import { deleteSavedFilter, saveFilter } from '../contacts/actions'
import { readColumns } from '../column-actions'
import { AddMarketplaceForm } from './add-marketplace'

export const metadata = { title: 'Marketplaces · FLO CRM' }

/**
 * The channels, rather than the counterparties.
 *
 * The same companies as /companies, narrowed to the ones with a marketplace
 * profile, and asked a different question. A buyer list wants to know who is
 * credible; this one wants to know what a channel costs and when it pays.
 */
export default async function MarketplacesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    error?: string
    view?: string
    f?: string
    match?: string
    group?: string
    subgroup?: string
    sort?: string
  }>
}) {
  const params = await searchParams
  const context = await requireSession()

  /*
   * An inner join spelled as a required embed: `!inner` makes PostgREST drop
   * companies with no profile rather than returning them with a null one.
   *
   * The filter is not applied here. Half the fields worth filtering on live on
   * the embedded profile, and the query path packs a condition into
   * `column.operator.value` and splits it on the first dot — a dotted column
   * cannot survive that. So the whole (bounded) list is fetched and the same
   * FilterConfig is evaluated over it in memory. The bound is the same 500 the
   * page has always loaded, and a marketplace list is dozens of rows.
   */
  const query = scoped(context, 'companies')
    .select('*, contacts(count), marketplace_profiles!inner(*)', { count: 'exact' })
    .is('deleted_at', null)

  const [
    { data, count },
    { data: owners },
    { data: fieldOptions },
    { data: definitionRows },
    { data: pickable },
    { data: savedFilterRows },
    { data: countryRows },
  ] = await Promise.all([
      query.order('name').limit(500),
      scoped(context, 'users').select('*').order('name'),
      // All on the company entity, priority included — a marketplace is a
      // company and reads the company's priority rather than its own.
      scoped(context, 'field_options')
        .select('*')
        .eq('entity_type', 'company')
        .order('order'),
      scoped(context, 'custom_field_definitions')
        .select('*')
        .eq('entity_type', 'company')
        .order('order'),
      /*
       * For the picker in "Add marketplace". Two columns and bounded, the same
       * shape the sales order pickers use — a marketplace is promoted from an
       * existing company rather than created, so there has to be a list to
       * promote from.
       */
      scoped(context, 'companies')
        .select('id, name')
        .is('deleted_at', null)
        .order('name')
        .limit(500),
      /*
       * Its own entity type, not 'company'. A marketplace is the same record as
       * a company, but a saved view belongs to the screen that asked the
       * question — filing them together would put every marketplace view in the
       * Companies list and the other way round.
       */
      scoped(context, 'saved_filters').select('*').eq('entity_type', 'marketplace'),
      /*
       * Reference data, not tenant data — no organization to scope it to, and
       * the same list for everybody. `based_in` and `sells_in` store codes, so
       * without these the page shows "CA" where it means Canada, and the
       * filter is a box you have to know to type a code into.
       */
      context.supabase
        .from('countries')
        .select('code, name, kind')
        .order('sort_order')
        .order('name'),
    ])

  type Row = CompanyRow & {
    contacts: { count: number }[]
    marketplace_profiles: MarketplaceProfileRow
  }

  const savedFilters = (savedFilterRows ?? []) as SavedFilterRow[]
  const places = placeNames((countryRows ?? []) as Place[])

  // A ?view=<id> link replays a saved filter; anything else comes from the URL.
  const savedView =
    typeof params.view === 'string'
      ? savedFilters.find((filter) => filter.id === params.view)
      : undefined
  const config = savedView ? parseFilterConfig(savedView.filter_json) : filterFromSearchParams(params)

  const everything = (data ?? []) as Row[]
  const ownerList = (owners ?? []) as UserRow[]
  const ownerNames = new Map(ownerList.map((user) => [user.id, user.name || user.email]))

  /*
   * The filter and the sort, run here rather than in the query. Sorted after
   * filtering rather than before, so a sort by a profile field orders what is
   * actually on screen; without a chosen sort the alphabetical order the query
   * asked for is left alone.
   */
  const rows = sortRows(
    everything.filter((row) => matchesFilter(row, config, 'marketplace')),
    config.sort,
  )

  // "Nothing matches" versus "nothing here yet" — the difference is whether
  // anything was actually asked for.
  const narrowed = Boolean(config.search) || config.conditions.length > 0
  const allOptions = (fieldOptions ?? []) as FieldOptionRow[]
  const optionsFor = (key: string) => allOptions.filter((option) => option.field_key === key)
  const definitions = (definitionRows ?? []) as CustomFieldDefinitionRow[]

  const savedColumns = await readColumns('marketplace')

  const catalogue = columnCatalogue('marketplace', definitions)
  const columns = resolveColumns('marketplace', savedColumns, catalogue)


  /*
   * Headline counts describe every marketplace, not the filtered view, so they
   * stay put while somebody narrows the list underneath them — the same rule
   * the contacts list follows.
   */
  const selling = everything.filter((row) => row.marketplace_profiles.sells_through)
  const sourcing = everything.filter((row) => row.marketplace_profiles.sources_from)

  const auctions = everything.filter((row) =>
    row.marketplace_profiles.marketplace_type?.includes('Auction'),
  )
  /*
   * Counted rather than averaged. A cost band has no mean worth reporting —
   * "Medium" is a judgement, not a number — so the headline is how many of the
   * cheap ones there are, which is the thing worth knowing at a glance.
   */
  const lowCost = everything.filter((row) => row.marketplace_profiles.selling_cost === 'Low')

  /*
   * The option lists behind the conditions, so a filter on selling cost offers
   * High / Medium / Low rather than a text box. Keyed by the field path, which
   * is what the FilterBar has to hand.
   */
  const fieldOptionsByKey: Record<string, string> = {
    priority: MARKETPLACE_OPTION_FIELDS.priority,
    specialty_market: 'specialty_market',
    'marketplace_profiles.marketplace_type': MARKETPLACE_OPTION_FIELDS.type,
    'marketplace_profiles.fulfilment': MARKETPLACE_OPTION_FIELDS.fulfilment,
    'marketplace_profiles.audience': MARKETPLACE_OPTION_FIELDS.audience,
    'marketplace_profiles.inventory_type': MARKETPLACE_OPTION_FIELDS.inventoryType,
    'marketplace_profiles.payment': MARKETPLACE_OPTION_FIELDS.payment,
    'marketplace_profiles.selling_cost': MARKETPLACE_OPTION_FIELDS.sellingCost,
    'marketplace_profiles.account_status': 'marketplace_account_status',
  }

  const fields = MARKETPLACE_FIELDS.map((field) => {
    // An owner is a uuid; the list has to offer names.
    if (field.key === 'owner_id') {
      return {
        ...field,
        options: ownerList.map((user) => ({ value: user.id, label: user.name || user.email })),
      }
    }

    /*
     * The geography fields come from the reference tables rather than from an
     * organization's option lists — there is no field_options row for a
     * country. Without these the condition falls back to a text box, and the
     * value it wants is "CA" rather than "Canada", which nobody would guess.
     */
    if (field.key === 'based_in' || field.key === 'sells_in') {
      return { ...field, options: places.countryOptions }
    }

    const optionKey = fieldOptionsByKey[field.key]
    if (!optionKey) return field

    const options = optionsFor(optionKey).map((option) => ({
      value: option.value,
      label: option.value,
    }))

    // An empty list would render a Select… with nothing in it, which is worse
    // than the free-text box the field would otherwise get.
    return options.length > 0 ? { ...field, options } : field
  })

  // Headings come off the same field list the filter uses. See labelFromFields.
  const groups = groupRowsNested(rows, config.groupBy, config.subGroupBy, labelFromFields(fields))

  const cell = (row: Row, key: string): React.ReactNode => {
    const profile = row.marketplace_profiles

    switch (key) {
      case 'name':
        return (
          <Link
            href={`/marketplaces/${row.id}`}
            className="block truncate font-medium text-slate-900 hover:text-brand-700"
          >
            {row.name}
          </Link>
        )
      case 'direction':
        return <span className="text-slate-600">{directionLabel(profile)}</span>
      case 'marketplace_type':
        return (
          <OptionBadges
            values={profile.marketplace_type}
            options={optionsFor(MARKETPLACE_OPTION_FIELDS.type)}
          />
        )
      case 'fulfilment':
        return (
          <OptionBadges
            values={profile.fulfilment}
            options={optionsFor(MARKETPLACE_OPTION_FIELDS.fulfilment)}
          />
        )
      case 'audience':
        return (
          <OptionBadges
            values={profile.audience}
            options={optionsFor(MARKETPLACE_OPTION_FIELDS.audience)}
          />
        )
      case 'inventory_type':
        return (
          <OptionBadges
            values={profile.inventory_type}
            options={optionsFor(MARKETPLACE_OPTION_FIELDS.inventoryType)}
          />
        )
      case 'payment':
        return profile.payment ? (
          <OptionBadge
            value={profile.payment}
            color={optionColor(optionsFor(MARKETPLACE_OPTION_FIELDS.payment), profile.payment)}
          />
        ) : (
          <Empty />
        )
      case 'selling_cost':
        return profile.selling_cost ? (
          <OptionBadge
            value={profile.selling_cost}
            color={optionColor(
              optionsFor(MARKETPLACE_OPTION_FIELDS.sellingCost),
              profile.selling_cost,
            )}
          />
        ) : (
          <Empty />
        )
      // The company's own, not a copy — the same reasoning as sells_in.
      case 'priority':
        return row.priority ? (
          <OptionBadge
            value={row.priority}
            color={optionColor(optionsFor(MARKETPLACE_OPTION_FIELDS.priority), row.priority)}
          />
        ) : (
          <Empty />
        )
      case 'buyers_premium': {
        // Three states. "Not recorded" is not "No".
        const answer = yesNo(profile.buyers_premium)
        return answer === null ? <Empty /> : <span className="text-slate-600">{answer}</span>
      }
      case 'settlement_terms':
        return profile.settlement_terms ? (
          <span className="text-slate-600">{profile.settlement_terms}</span>
        ) : (
          <Empty />
        )
      case 'account_status':
        return profile.account_status ? (
          <OptionBadge
            value={profile.account_status}
            color={optionColor(optionsFor('marketplace_account_status'), profile.account_status)}
          />
        ) : (
          <Empty />
        )
      case 'store_name':
        return profile.store_name ? (
          <span className="block truncate text-slate-600">{profile.store_name}</span>
        ) : (
          <Empty />
        )
      case 'reserve_percent':
        return profile.reserve_percent === null ? (
          <Empty />
        ) : (
          <span className="text-slate-600">{Number(profile.reserve_percent)}%</span>
        )
      case 'minimum_lot_value':
        return profile.minimum_lot_value === null ? (
          <Empty />
        ) : (
          <span className="text-slate-600">
            {formatPrice(
              Number(profile.minimum_lot_value),
              profile.payout_currency ?? context.organization.default_currency,
            )}
          </span>
        )
      case 'payout_currency':
        return profile.payout_currency ? (
          <span className="text-slate-600">{profile.payout_currency}</span>
        ) : (
          <Empty />
        )
      case 'owner':
        return row.owner_id ? (
          <span className="text-slate-600">{ownerNames.get(row.owner_id) ?? '—'}</span>
        ) : (
          <Empty />
        )
      case 'contacts':
        return <span className="text-slate-600">{row.contacts?.[0]?.count ?? 0}</span>
      // Codes in the column, names on the screen. See src/lib/geography.ts.
      case 'based_in':
        return row.based_in ? (
          <span className="text-slate-600">{places.country(row.based_in)}</span>
        ) : (
          <Empty />
        )
      case 'sells_in':
        return row.sells_in?.length ? (
          <span className="block truncate text-slate-600">
            {row.sells_in.map((code) => places.country(code)).join(', ')}
          </span>
        ) : (
          <Empty />
        )
      case 'specialty_market':
        return <OptionBadges values={row.specialty_market} options={optionsFor('specialty_market')} />
      case 'domain':
        return row.domain ? (
          <a
            href={row.domain.startsWith('http') ? row.domain : `https://${row.domain}`}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-brand-700 hover:underline"
          >
            {row.domain}
          </a>
        ) : (
          <Empty />
        )
      case 'opened_on':
        return profile.opened_on ? (
          <span className="text-slate-600">{formatDay(profile.opened_on)}</span>
        ) : (
          <Empty />
        )
      default:
        return <CustomCell row={row} columnKey={key} />
    }
  }

  return (
    <>
      <PageHeader
        title="Marketplaces"
        description="The channels you trade through. Each one is a company — the same record, its contacts and its history — with what it costs to trade there on top."
        actions={
          <>
            <ColumnPicker
              entity="marketplace"
              catalogue={catalogue}
              selected={columns.map((column) => column.key)}
            />
            {context.canWrite && (
              <AddMarketplaceForm companies={(pickable ?? []) as { id: string; name: string }[]} />
            )}
          </>
        }
      />

      {params.error && (
        <p className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {params.error}
        </p>
      )}

      <StatGrid>
        <StatCard label="Marketplaces" value={String(count ?? rows.length)} icon={StoreIcon} />
        <StatCard
          label="Sell through"
          value={String(selling.length)}
          icon={LayersIcon}
          tone="brand"
        />
        <StatCard
          label="Source from"
          value={String(sourcing.length)}
          icon={TagIcon}
          tone="violet"
        />
        <StatCard
          label="Low selling cost"
          value={String(lowCost.length)}
          icon={TagIcon}
          tone="amber"
          hint={auctions.length > 0 ? `${auctions.length} auction` : undefined}
        />
      </StatGrid>

      <FilterBar
        fields={fields}
        initial={config}
        savedFilters={savedFilters}
        entityType="marketplace"
        currentUserId={context.user.id}
        canExport={context.canBulk}
        saveAction={saveFilter}
        deleteAction={deleteSavedFilter}
      />

      {rows.length === 0 ? (
        <EmptyState
          title={narrowed ? 'No marketplaces match that' : 'No marketplaces yet'}
          description={
            narrowed
              ? 'Try a different search, or clear the filters.'
              : 'A marketplace is a company you trade through. Add one from an existing company — its contacts, notes and history come with it.'
          }
        />
      ) : (
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
                rounded corners land on the column header row.
              */}
              <div className="group-panel overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
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
                    {/*
                      With a sub-group, each one gets a heading row and then its
                      rows; without, the rows go straight in. Same table either
                      way, so the columns keep their widths.
                    */}
                    {(group.subGroups ?? [{ key: null, label: '', rows: group.rows }]).flatMap(
                      (sub) => [
                        ...(group.subGroups
                          ? [
                              <SubGroupRow
                                key={`sub-${sub.key ?? 'none'}`}
                                label={sub.label}
                                count={sub.rows.length}
                                columns={columns.length}
                              />,
                            ]
                          : []),
                        ...sub.rows.map((row) => (
                          <tr key={row.id} className="transition-colors hover:bg-slate-50/70">
                            {columns.map((column) => (
                              <td
                                key={column.key}
                                className={column.align === 'right' ? 'text-right' : undefined}
                              >
                                <div className="min-w-0 max-w-xs">{cell(row, column.key)}</div>
                              </td>
                            ))}
                          </tr>
                        )),
                      ],
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
