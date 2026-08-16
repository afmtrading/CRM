import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatDay, formatPrice } from '@/lib/format'
import { likeContains } from '@/lib/sql'
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
import { EmptyState, PageHeader, StatCard, StatGrid } from '@/components/ui'
import { LayersIcon, SearchIcon, StoreIcon, TagIcon } from '@/components/icons'

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
  searchParams: Promise<{ q?: string; error?: string }>
}) {
  const params = await searchParams
  const context = await requireSession()
  const search = (params.q ?? '').trim()

  /*
   * An inner join spelled as a required embed: `!inner` makes PostgREST drop
   * companies with no profile rather than returning them with a null one.
   */
  let query = scoped(context, 'companies')
    .select('*, contacts(count), marketplace_profiles!inner(*)', { count: 'exact' })
    .is('deleted_at', null)

  if (search) query = query.ilike('name', likeContains(search))

  const [
    { data, count },
    { data: owners },
    { data: fieldOptions },
    { data: definitionRows },
    { data: pickable },
  ] = await Promise.all([
      query.order('name').limit(500),
      scoped(context, 'users').select('*').order('name'),
      // Company and contact both: the marketplace lists live on the company
      // entity, and priority is reused from the contact one on purpose.
      scoped(context, 'field_options')
        .select('*')
        .in('entity_type', ['company', 'contact'])
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
    ])

  type Row = CompanyRow & {
    contacts: { count: number }[]
    marketplace_profiles: MarketplaceProfileRow
  }

  const rows = (data ?? []) as Row[]
  const ownerList = (owners ?? []) as UserRow[]
  const ownerNames = new Map(ownerList.map((user) => [user.id, user.name || user.email]))
  const allOptions = (fieldOptions ?? []) as FieldOptionRow[]
  const optionsFor = (key: string) => allOptions.filter((option) => option.field_key === key)
  const definitions = (definitionRows ?? []) as CustomFieldDefinitionRow[]

  const savedColumns = await readColumns('marketplace')

  const catalogue = columnCatalogue('marketplace', definitions)
  const columns = resolveColumns('marketplace', savedColumns, catalogue)

  const selling = rows.filter((row) => row.marketplace_profiles.sells_through)
  const sourcing = rows.filter((row) => row.marketplace_profiles.sources_from)

  const auctions = rows.filter((row) =>
    row.marketplace_profiles.marketplace_type?.includes('Auction'),
  )
  /*
   * Counted rather than averaged. A cost band has no mean worth reporting —
   * "Medium" is a judgement, not a number — so the headline is how many of the
   * cheap ones there are, which is the thing worth knowing at a glance.
   */
  const lowCost = rows.filter((row) => row.marketplace_profiles.selling_cost === 'Low')

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
      case 'based_in':
        return row.based_in ? <span className="text-slate-600">{row.based_in}</span> : <Empty />
      case 'sells_in':
        return row.sells_in?.length ? (
          <span className="block truncate text-slate-600">{row.sells_in.join(', ')}</span>
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

      <form action="/marketplaces" className="relative mb-4 max-w-md">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Search marketplaces…"
          aria-label="Search marketplaces"
          className="input bg-slate-50 pl-9"
        />
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={search ? 'No marketplaces match that' : 'No marketplaces yet'}
          description="A marketplace is a company you trade through. Add one from an existing company — its contacts, notes and history come with it."
        />
      ) : (
        <div className="card overflow-x-auto">
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
              {rows.map((row) => (
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
