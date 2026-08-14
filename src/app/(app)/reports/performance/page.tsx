import Link from 'next/link'

import { requireSession } from '@/lib/tenancy'
import { todayIn } from '@/lib/timezone'
import { formatNumber, formatPercent } from '@/lib/format'
import type { LedgerRow } from '@/lib/ledger'
import {
  PERIOD_OPTIONS,
  overallPerformance,
  parsePeriodKey,
  performanceByOwner,
  performanceScope,
  periodRange,
  type Performance,
} from '@/lib/performance'
import { MoneyTotals } from '@/components/money'
import { EmptyState, ErrorNote, PageHeader } from '@/components/ui'

export const metadata = { title: 'Sales performance · FLO CRM' }

// Computed from the deal records on every request, like every other report
// here. A cached scoreboard is a scoreboard somebody will argue with.
export const dynamic = 'force-dynamic'

export default async function SalesPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const context = await requireSession()
  // Every day on this page is the organization's, not the server's.
  const today = todayIn(context.organization.timezone)

  const one = (key: string) => {
    const value = params[key]
    return (Array.isArray(value) ? value[0] : value) ?? ''
  }

  const period = periodRange(parsePeriodKey(one('period')), today, {
    from: one('from'),
    to: one('to'),
  })

  /*
   * The same function the ledger reads, and the reason this page needs no
   * access rules of its own: deal_ledger is invoker, so the rows that arrive
   * are already the rows this person is allowed to see. A manager gets the
   * organization; everybody else gets their own. There is no query here that
   * could accidentally widen that.
   */
  const { data: ledger, error } = await context.supabase.rpc('deal_ledger', {
    // Nothing here reads row.regions, so the field-definition lookup that
      // used to resolve the key is a round trip for an unused column.
      p_region_key: null,
  })

  const rows = (ledger ?? []) as LedgerRow[]
  const overall = overallPerformance(rows, period)
  const owners = performanceByOwner(rows, period)
  const scope = performanceScope(context.canManage, owners.length)

  const link = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    for (const key of ['period', 'from', 'to']) {
      const value = one(key)
      if (value) next.set(key, value)
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (!value) next.delete(key)
      else next.set(key, value)
    }
    const query = next.toString()
    return query ? `/reports/performance?${query}` : '/reports/performance'
  }

  return (
    <>
      <PageHeader
        title="Sales performance"
        description={
          scope === 'own'
            ? 'Your own deals. Closed figures cover the selected period; open pipeline is where it stands today.'
            : 'Closed figures cover the selected period; open pipeline is where it stands today. A won deal counts for whoever owned it when it closed.'
        }
        actions={
          <>
            <Link href="/reports/deals" className="btn-secondary">
              Deal ledger
            </Link>
            <Link href="/reports/charts" className="btn-secondary">
              Charts
            </Link>
            <Link href="/reports/diagnostics" className="btn-secondary">
              Diagnostics
            </Link>
          </>
        }
      />

      {error && <ErrorNote>{error.message}</ErrorNote>}

      {/* ------------------------------------------------------------------ */}
      {/* Period                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-5 flex flex-wrap items-end gap-2">
        {PERIOD_OPTIONS.filter((option) => option.key !== 'custom').map((option) => (
          <Link
            key={option.key}
            href={link({ period: option.key, from: undefined, to: undefined })}
            className={`rounded-full px-3 py-1 text-sm ${
              period.key === option.key
                ? 'bg-brand-700 text-white'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {option.label}
          </Link>
        ))}

        <form className="ml-auto flex items-end gap-2">
          <input type="hidden" name="period" value="custom" />
          <div>
            <label className="label" htmlFor="from">
              From
            </label>
            <input id="from" name="from" type="date" className="input" defaultValue={one('from')} />
          </div>
          <div>
            <label className="label" htmlFor="to">
              To
            </label>
            <input id="to" name="to" type="date" className="input" defaultValue={one('to')} />
          </div>
          <button type="submit" className="btn-secondary">
            Apply
          </button>
        </form>
      </div>

      <p className="mb-5 text-sm text-slate-500">
        Showing <span className="font-medium text-slate-700">{period.label}</span>
        {period.key !== 'all' && ' — by close date'}.
      </p>

      {/* ------------------------------------------------------------------ */}
      {/* Overall                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Tile label="Won">
          <MoneyTotals rows={overall.wonValue} amountClassName="text-lg font-semibold text-slate-900" />
          <Note>
            {formatNumber(overall.won)} deal{overall.won === 1 ? '' : 's'}
          </Note>
        </Tile>

        <Tile label="Win rate">
          <Big>
            {overall.winRate === null ? '—' : formatPercent(overall.winRate)}
          </Big>
          <Note>
            {overall.winRate === null
              ? 'Nothing closed in this period'
              : `${formatNumber(overall.won)} won · ${formatNumber(overall.lost)} lost` +
                (overall.winRateByValue === null
                  ? ''
                  : ` · ${formatPercent(overall.winRateByValue)} by value`)}
          </Note>
        </Tile>

        <Tile label="Average deal">
          <MoneyTotals
            rows={overall.averageDeal}
            amountClassName="text-lg font-semibold text-slate-900"
          />
          <Note>Mean won deal</Note>
        </Tile>

        <Tile label="Median cycle">
          <Big>{overall.medianCycle === null ? '—' : `${formatNumber(overall.medianCycle)}d`}</Big>
          <Note>
            {overall.medianCycle === null ? 'Nothing closed yet' : 'Created to closed, median'}
          </Note>
        </Tile>

        <Tile label="Open pipeline">
          <MoneyTotals
            rows={overall.openPipeline}
            amountClassName="text-lg font-semibold text-slate-900"
          />
          <Note>{formatNumber(overall.open)} open, as of today</Note>
        </Tile>

        <Tile label="Open weighted">
          <MoneyTotals
            rows={overall.openWeighted}
            amountClassName="text-lg font-semibold text-slate-900"
          />
          <Note>Value × probability</Note>
        </Tile>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Per owner                                                           */}
      {/* ------------------------------------------------------------------ */}
      {owners.length === 0 ? (
        <EmptyState
          title="Nothing to report for this period"
          description="No deals closed in the selected period, and nothing is open. Try a wider period."
        />
      ) : (
        <section className="card overflow-hidden">
          <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <h2 className="text-base font-semibold text-slate-900">
              {scope === 'own' ? 'Your numbers' : 'By owner'}
            </h2>
            <p className="text-xs text-slate-500">
              {scope === 'own'
                ? 'You see your own deals only.'
                : 'Won and lost credit the owner at close; open credits the current owner.'}
            </p>
          </header>

          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Owner</th>
                  <th className="text-right">Won</th>
                  <th className="text-right">Win rate</th>
                  <th className="text-right">Average deal</th>
                  <th className="text-right">Median cycle</th>
                  <th className="text-right">Margin</th>
                  <th className="text-right">Open pipeline</th>
                  <th className="text-right">Open weighted</th>
                </tr>
              </thead>
              <tbody>
                {owners.map((row) => (
                  <OwnerRow key={row.owner.id ?? 'unassigned'} row={row} />
                ))}
              </tbody>
            </table>
          </div>

          {overall.marginUnknown > 0 && (
            <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
              Margin is unknown on {formatNumber(overall.marginUnknown)} won deal
              {overall.marginUnknown === 1 ? '' : 's'} priced by hand — there are no line items to
              cost, so they are left out of the margin rather than counted as zero.
            </p>
          )}
        </section>
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

function Big({ children }: { children: React.ReactNode }) {
  return <span className="text-lg font-semibold text-slate-900">{children}</span>
}

function Note({ children }: { children: React.ReactNode }) {
  return <span className="mt-0.5 block text-xs text-slate-500">{children}</span>
}

function OwnerRow({ row }: { row: Performance }) {
  return (
    <tr>
      <td className="font-medium text-slate-900">{row.owner.name}</td>
      <td className="text-right">
        <MoneyTotals rows={row.wonValue} />
        <span className="mt-0.5 block text-xs text-slate-400">
          {formatNumber(row.won)} deal{row.won === 1 ? '' : 's'}
        </span>
      </td>
      <td className="text-right">
        {row.winRate === null ? (
          <span className="text-slate-300" title="Nothing closed in this period">
            —
          </span>
        ) : (
          <>
            {formatPercent(row.winRate)}
            <span className="mt-0.5 block text-xs text-slate-400">
              {formatNumber(row.won)}W / {formatNumber(row.lost)}L
            </span>
          </>
        )}
      </td>
      <td className="text-right">
        {row.averageDeal.length === 0 ? <span className="text-slate-300">—</span> : <MoneyTotals rows={row.averageDeal} />}
      </td>
      <td className="text-right text-slate-600">
        {row.medianCycle === null ? (
          <span className="text-slate-300">—</span>
        ) : (
          `${formatNumber(row.medianCycle)}d`
        )}
      </td>
      <td className="text-right">
        {row.wonMargin.length === 0 ? (
          <span className="text-slate-300" title="No costed line items on the won deals">
            —
          </span>
        ) : (
          <>
            <MoneyTotals rows={row.wonMargin} />
            {row.marginUnknown > 0 && (
              <span className="mt-0.5 block text-xs text-amber-600">
                {formatNumber(row.marginUnknown)} unknown
              </span>
            )}
          </>
        )}
      </td>
      <td className="text-right">
        <MoneyTotals rows={row.openPipeline} />
        <span className="mt-0.5 block text-xs text-slate-400">
          {formatNumber(row.open)} open
        </span>
      </td>
      <td className="text-right text-slate-600">
        <MoneyTotals rows={row.openWeighted} />
      </td>
    </tr>
  )
}
