import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatDay, formatNumber, formatPercent } from '@/lib/format'
import {
  GROUPABLE_COLUMNS,
  LEDGER_COLUMNS,
  columnFor,
  applyLedgerFilter,
  groupLedger,
  groupingOverlaps,
  isFiltered,
  ledgerFilterFromParams,
  ledgerFilterToParams,
  parseSort,
  regionFieldKey,
  sortLedger,
  summariseLedger,
  type LedgerColumnKey,
  type LedgerRow,
} from '@/lib/ledger'
import { DATE_FIELDS } from '@/lib/ledger'
import type {
  CustomFieldDefinitionRow,
  PipelineRow,
  UserRow,
} from '@/lib/database.types'
import { Money, MoneyTotals } from '@/components/money'
import { DealStatusBadge, EmptyState, ErrorNote, PageHeader } from '@/components/ui'

export const metadata = { title: 'Deal ledger · FLO CRM' }

// Read live from the deals table on every request, like every other report
// here: a total that disagrees with the record it came from is worse than no
// total at all.
export const dynamic = 'force-dynamic'

/**
 * How many deals the ledger will hold at once.
 *
 * Generous rather than unlimited. The screen says when it has hit the ceiling
 * instead of quietly showing a prefix, and the export is separately capped
 * higher — a truncated report that does not admit it is the one failure mode
 * worth engineering against.
 */
const LEDGER_LIMIT = 5000

export default async function DealLedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const context = await requireSession()

  const filter = ledgerFilterFromParams(params)
  const sort = parseSort(Array.isArray(params.sort) ? params.sort[0] : params.sort)
  const rawGroup = Array.isArray(params.group) ? params.group[0] : params.group
  const groupBy = (columnFor(rawGroup ?? '')?.groupable ? rawGroup : null) as
    | LedgerColumnKey
    | null

  const [{ data: definitions }, { data: pipelines }, { data: users }] = await Promise.all([
    scoped(context, 'custom_field_definitions').select('*'),
    scoped(context, 'pipelines').select('*').order('name'),
    scoped(context, 'users').select('*').order('name'),
  ])

  const regionKey = regionFieldKey((definitions ?? []) as CustomFieldDefinitionRow[])

  const { data: ledger, error } = await context.supabase.rpc('deal_ledger', {
    p_region_key: regionKey,
  })

  const allRows = ((ledger ?? []) as LedgerRow[]).slice(0, LEDGER_LIMIT)
  const rows = sortLedger(applyLedgerFilter(allRows, filter), sort)
  const groups = groupLedger(rows, groupBy)
  const summary = summariseLedger(rows)
  const overlaps = groupingOverlaps(groupBy)

  // The filter dropdowns offer what is actually there rather than every value
  // in the database — an option that matches nothing is a dead end.
  const products = [...new Set(allRows.flatMap((row) => row.products))].sort()
  const regions = [...new Set(allRows.flatMap((row) => row.regions))].sort()
  const reasons = [...new Set(allRows.map((row) => row.loss_reason).filter(Boolean))].sort() as string[]
  const companies = [
    ...new Map(
      allRows
        .filter((row) => row.company_id && row.company_name)
        .map((row) => [row.company_id as string, row.company_name as string]),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]))

  const columns = LEDGER_COLUMNS.filter(
    // No point in a Region column for an organization that does not keep one.
    (column) => column.key !== 'regions' || regionKey !== null,
  )

  /** A link that keeps every other choice and changes one. */
  const link = (overrides: Record<string, string | undefined>) => {
    const next = ledgerFilterToParams(filter)
    if (groupBy) next.set('group', groupBy)
    next.set('sort', `${sort.key}:${sort.direction}`)

    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === '') next.delete(key)
      else next.set(key, value)
    }

    const query = next.toString()
    return query ? `/reports/deals?${query}` : '/reports/deals'
  }

  const sortLink = (key: LedgerColumnKey) =>
    link({
      sort: `${key}:${sort.key === key && sort.direction === 'desc' ? 'asc' : 'desc'}`,
    })

  const exportHref = `/api/export?entity=deal_ledger&${ledgerFilterToParams(filter).toString()}`

  return (
    <>
      <PageHeader
        title="Deal ledger"
        description="Every deal ever recorded — open, won and lost. A deal leaves the board when it closes; it never leaves here."
        actions={
          <>
            <Link href="/reports/performance" className="btn-secondary">
              Performance
            </Link>
            <Link href="/reports/pipeline-value" className="btn-secondary">
              Pipeline value
            </Link>
            <a href={exportHref} className="btn-secondary">
              Export CSV
            </a>
          </>
        }
      />

      {error && <ErrorNote>{error.message}</ErrorNote>}

      {/* ------------------------------------------------------------------ */}
      {/* The totals, before the rows: the answer first, the evidence after. */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Deals">
          <span className="text-xl font-semibold text-slate-900">{formatNumber(summary.deals)}</span>
          <span className="mt-0.5 block text-xs text-slate-500">
            {formatNumber(summary.open)} open · {formatNumber(summary.won)} won ·{' '}
            {formatNumber(summary.lost)} lost
          </span>
        </Tile>

        <Tile label="Won value">
          <MoneyTotals rows={summary.wonValue} amountClassName="text-xl font-semibold text-slate-900" />
          <span className="mt-0.5 block text-xs text-slate-500">
            {summary.winRate === null
              ? 'Nothing closed yet'
              : `${formatPercent(summary.winRate)} win rate by count`}
          </span>
        </Tile>

        <Tile label="Open weighted">
          <MoneyTotals
            rows={summary.openWeighted}
            amountClassName="text-xl font-semibold text-slate-900"
          />
          <span className="mt-0.5 block text-xs text-slate-500">
            Value × probability, open deals only
          </span>
        </Tile>

        <Tile label="Margin">
          <MoneyTotals rows={summary.margin} amountClassName="text-xl font-semibold text-slate-900" />
          <span className="mt-0.5 block text-xs text-slate-500">
            {summary.marginUnknown > 0
              ? `Unknown on ${formatNumber(summary.marginUnknown)} priced by hand`
              : 'From line items'}
            {summary.marginPartial > 0 &&
              ` · ${formatNumber(summary.marginPartial)} missing a cost`}
          </span>
        </Tile>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Filters. A GET form, so every view is a URL somebody can send.      */}
      {/* ------------------------------------------------------------------ */}
      <form className="card mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Search" htmlFor="q">
          <input
            id="q"
            name="q"
            className="input"
            defaultValue={filter.search}
            placeholder="Deal, company, contact, product"
          />
        </Field>

        <Field label="Status" htmlFor="status">
          <select id="status" name="status" className="input" defaultValue={filter.status}>
            <option value="all">All — open, won and lost</option>
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </select>
        </Field>

        <Field label="Owner" htmlFor="owner">
          <select id="owner" name="owner" className="input" defaultValue={filter.owner}>
            <option value="">Every owner</option>
            {((users ?? []) as UserRow[]).map((user) => (
              <option key={user.id} value={user.id}>
                {user.name || user.email}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Pipeline" htmlFor="pipeline">
          <select id="pipeline" name="pipeline" className="input" defaultValue={filter.pipeline}>
            <option value="">Every pipeline</option>
            {((pipelines ?? []) as PipelineRow[]).map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Company" htmlFor="company">
          <select id="company" name="company" className="input" defaultValue={filter.company}>
            <option value="">Every company</option>
            {companies.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Product" htmlFor="product">
          <select id="product" name="product" className="input" defaultValue={filter.product}>
            <option value="">Every product</option>
            {products.map((product) => (
              <option key={product} value={product}>
                {product}
              </option>
            ))}
          </select>
        </Field>

        {regionKey && (
          <Field label="Region" htmlFor="region">
            <select id="region" name="region" className="input" defaultValue={filter.region}>
              <option value="">Every region</option>
              {regions.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </Field>
        )}

        {reasons.length > 0 && (
          <Field label="Loss reason" htmlFor="reason">
            <select id="reason" name="reason" className="input" defaultValue={filter.lossReason}>
              <option value="">Any reason</option>
              {reasons.map((reason) => (
                <option key={reason} value={reason}>
                  {reason}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Group by" htmlFor="group">
          <select id="group" name="group" className="input" defaultValue={groupBy ?? ''}>
            <option value="">No grouping</option>
            {GROUPABLE_COLUMNS.filter(
              (column) => column.key !== 'regions' || regionKey !== null,
            ).map((column) => (
              <option key={column.key} value={column.key}>
                {column.label}
              </option>
            ))}
          </select>
        </Field>

        {/* A date range means nothing until it says which date it is about. */}
        <Field label="Date range on" htmlFor="date">
          <select id="date" name="date" className="input" defaultValue={filter.dateField}>
            {DATE_FIELDS.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="From" htmlFor="from">
          <input id="from" name="from" type="date" className="input" defaultValue={filter.from} />
        </Field>

        <Field label="To" htmlFor="to">
          <input id="to" name="to" type="date" className="input" defaultValue={filter.to} />
        </Field>

        <input type="hidden" name="sort" value={`${sort.key}:${sort.direction}`} />

        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
          <button type="submit" className="btn-primary">
            Apply
          </button>
          {isFiltered(filter) || groupBy ? (
            <Link href="/reports/deals" className="btn-secondary">
              Clear
            </Link>
          ) : null}
          <span className="ml-auto text-xs text-slate-500">
            {formatNumber(rows.length)} of {formatNumber(allRows.length)} deals
          </span>
        </div>
      </form>

      {allRows.length >= LEDGER_LIMIT && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Showing the most recent {formatNumber(LEDGER_LIMIT)} deals. Narrow the date range to see
          further back — the export carries more.
        </p>
      )}

      {overlaps && (
        <p className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          A deal can belong to more than one {columnFor(groupBy!)?.label.toLowerCase()}, so it
          appears in each group it belongs to. Group subtotals therefore add up to more than the{' '}
          {formatNumber(rows.length)} deals above.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title={allRows.length === 0 ? 'No deals yet' : 'No deals match this view'}
          description={
            allRows.length === 0
              ? 'Every deal you record will appear here and stay here, whatever happens to it.'
              : 'Try a wider date range, or clear the filters.'
          }
        />
      ) : (
        <div className="space-y-5">
          {groups.map((group) => {
            const groupSummary = summariseLedger(group.rows)

            return (
              <section key={group.key ?? '—'} className="card overflow-hidden">
                {groupBy && (
                  <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-100 px-5 py-3">
                    <h2 className="text-sm font-semibold text-slate-900">{group.label}</h2>
                    <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500">
                      <span>{formatNumber(group.rows.length)} deals</span>
                      <span className="text-slate-300">·</span>
                      <MoneyTotals rows={groupSummary.totalValue} />
                      {groupSummary.winRate !== null && (
                        <>
                          <span className="text-slate-300">·</span>
                          <span>{formatPercent(groupSummary.winRate)} won</span>
                        </>
                      )}
                    </p>
                  </header>
                )}

                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        {columns.map((column) => (
                          <th
                            key={column.key}
                            className={column.numeric ? 'text-right' : undefined}
                          >
                            <Link
                              href={sortLink(column.key)}
                              className="hover:text-slate-900"
                              title={`Sort by ${column.label}`}
                            >
                              {column.label}
                              {sort.key === column.key && (
                                <span className="ml-1 text-slate-400">
                                  {sort.direction === 'asc' ? '↑' : '↓'}
                                </span>
                              )}
                            </Link>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row) => (
                        <tr key={row.deal_id}>
                          {columns.map((column) => (
                            <td
                              key={column.key}
                              className={column.numeric ? 'text-right' : undefined}
                            >
                              <Cell row={row} column={column.key} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

const EMPTY = <span className="text-slate-300">—</span>

/** One cell. Kept in one place so the column list decides the table's shape. */
function Cell({ row, column }: { row: LedgerRow; column: LedgerColumnKey }) {
  switch (column) {
    case 'name':
      return (
        <Link
          href={`/deals/${row.deal_id}`}
          className="font-medium text-slate-900 hover:text-brand-700"
        >
          {row.name}
        </Link>
      )

    case 'status':
      return <DealStatusBadge status={row.status} />

    case 'value':
      return <Money value={Number(row.value)} currency={row.currency} />

    case 'weighted_value':
      return <Money value={Number(row.weighted_value)} currency={row.currency} />

    case 'margin':
      // The distinction the whole report turns on: no line items means the
      // margin is unknown, and saying nothing is more honest than saying zero.
      return row.margin === null ? (
        <span className="text-xs text-slate-400" title="Priced by hand — no line items to cost">
          unknown
        </span>
      ) : (
        <span
          title={
            row.costed_lines < row.line_count
              ? `${row.line_count - row.costed_lines} of ${row.line_count} lines have no cost recorded`
              : undefined
          }
        >
          <Money value={Number(row.margin)} currency={row.currency} />
          {row.costed_lines < row.line_count && <span className="ml-1 text-amber-600">*</span>}
        </span>
      )

    case 'company_name':
      return row.company_id && row.company_name ? (
        <Link href={`/companies/${row.company_id}`} className="text-brand-700 hover:underline">
          {row.company_name}
        </Link>
      ) : (
        EMPTY
      )

    case 'contact_name':
      return row.contact_id && row.contact_name ? (
        <Link href={`/contacts/${row.contact_id}`} className="text-brand-700 hover:underline">
          {row.contact_name}
        </Link>
      ) : (
        EMPTY
      )

    case 'products':
    case 'regions': {
      const values = row[column]
      if (values.length === 0) return EMPTY
      return (
        <span className="flex flex-wrap gap-1">
          {values.map((value) => (
            <span
              key={value}
              className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
            >
              {value}
            </span>
          ))}
        </span>
      )
    }

    case 'created_at':
      return <>{formatDay(row.created_at)}</>

    case 'expected_close_date':
    case 'actual_close_date':
      return row[column] ? <>{formatDay(row[column])}</> : EMPTY

    case 'cycle_days':
      return row.cycle_days === null ? EMPTY : <>{formatNumber(row.cycle_days)}</>

    default: {
      const value = row[column as keyof LedgerRow]
      return value ? <>{String(value)}</> : EMPTY
    }
  }
}
