import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatNumber } from '@/lib/format'
import { regionFieldKey, type LedgerRow } from '@/lib/ledger'
import {
  PERIOD_OPTIONS,
  parsePeriodKey,
  periodRange,
} from '@/lib/performance'
import {
  closedByMonth,
  currenciesIn,
  cycleHistogram,
  openByStage,
  ownerBars,
} from '@/lib/charts'
import type { CustomFieldDefinitionRow } from '@/lib/database.types'
import {
  CycleHistogram,
  MonthlyColumns,
  OwnerBars,
  StageBars,
} from '@/components/charts'
import { EmptyState, ErrorNote, PageHeader } from '@/components/ui'

export const metadata = { title: 'Charts · FLO CRM' }

export const dynamic = 'force-dynamic'

export default async function ReportChartsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const context = await requireSession()

  const one = (key: string) => {
    const value = params[key]
    return (Array.isArray(value) ? value[0] : value) ?? ''
  }

  const period = periodRange(parsePeriodKey(one('period')), new Date(), {
    from: one('from'),
    to: one('to'),
  })

  const { data: definitions } = await scoped(context, 'custom_field_definitions').select('*')

  // The same ledger the other two reports read, and the same reason it needs no
  // access rules of its own: invoker, so the rows that arrive are the rows this
  // person may see.
  const { data: ledger, error } = await context.supabase.rpc('deal_ledger', {
    p_region_key: regionFieldKey((definitions ?? []) as CustomFieldDefinitionRow[]),
  })

  const rows = (ledger ?? []) as LedgerRow[]
  const currencies = currenciesIn(rows)
  const cycles = cycleHistogram(rows, period)

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
    return query ? `/reports/charts?${query}` : '/reports/charts'
  }

  return (
    <>
      <PageHeader
        title="Charts"
        description="The same deals the ledger holds, drawn. Closed figures cover the selected period; open pipeline is where it stands today."
        actions={
          <>
            <Link href="/reports/deals" className="btn-secondary">
              Deal ledger
            </Link>
            <Link href="/reports/performance" className="btn-secondary">
              Performance
            </Link>
            <Link href="/reports/product-mix" className="btn-secondary">
              Product mix
            </Link>
          </>
        }
      />

      {error && <ErrorNote>{error.message}</ErrorNote>}

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

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing to draw yet"
          description="Charts appear as deals are recorded and closed. Every deal you make from here counts towards them."
        />
      ) : (
        <div className="space-y-5">
          {/*
            One set of charts per currency. Two currencies on one axis would
            draw a total that does not exist, so they get their own panels.
          */}
          {currencies.map((currency) => {
            const months = closedByMonth(rows, currency, period)
            const owners = ownerBars(rows, currency, period)
            const stages = openByStage(rows, currency)

            return (
              <div key={currency} className="space-y-5">
                {currencies.length > 1 && (
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                    {currency}
                  </h2>
                )}

                <Panel
                  title="Closed value by month"
                  note="Placed by close date, the same rule the performance tiles use."
                >
                  <MonthlyColumns buckets={months} currency={currency} />
                </Panel>

                <div className="grid gap-5 lg:grid-cols-2">
                  <Panel
                    title="Owners side by side"
                    note="Won and lost credit the owner at close; open credits the current owner."
                  >
                    <OwnerBars bars={owners} currency={currency} />
                  </Panel>

                  <Panel
                    title="Where the open pipeline sits"
                    /*
                     * Deliberately not called a funnel. A funnel needs to know
                     * which stages a deal passed through, and nothing records
                     * that — a deal carries only its current stage. Drawing this
                     * as a funnel would invite "we lose 60% at Proposal" to be
                     * read off a chart that cannot support the claim.
                     */
                    note="Open deals by their current stage — a snapshot, not a conversion funnel."
                  >
                    <StageBars stages={stages} currency={currency} />
                  </Panel>
                </div>
              </div>
            )
          })}

          {/* Days are days in any currency, so this one is not split. */}
          <Panel
            title="How long deals take"
            note="Created to closed. If the lost bars sit right of the won ones, deals are being chased after they were gone."
          >
            <CycleHistogram buckets={cycles} />
          </Panel>

          <p className="text-xs text-slate-400">
            Drawn from {formatNumber(rows.length)} deal{rows.length === 1 ? '' : 's'} you can see.
          </p>
        </div>
      )}
    </>
  )
}

function Panel({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-slate-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-slate-500">{note}</p>}
      </header>
      {children}
    </section>
  )
}
