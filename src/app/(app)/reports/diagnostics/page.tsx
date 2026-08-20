import Link from 'next/link'

import { requireSession } from '@/lib/tenancy'
import { todayIn } from '@/lib/timezone'
import { formatDay, formatNumber, formatPercent } from '@/lib/format'
import type { LedgerRow } from '@/lib/ledger'
import { PERIOD_OPTIONS, parsePeriodKey, periodRange } from '@/lib/performance'
import { funnelSteps, type StageFunnelRow } from '@/lib/charts'
import {
  STALLED_AFTER_DAYS,
  ageingBuckets,
  lossCoverage,
  lossReasons,
  overdueDeals,
  stalledDeals,
  withoutCloseDate,
  type StageDurationRow,
} from '@/lib/diagnostics'
import { MoneyTotals } from '@/components/money'
import { EmptyState, ErrorNote, PageHeader } from '@/components/ui'

export const metadata = { title: 'Diagnostics · FLO CRM' }

export const dynamic = 'force-dynamic'

/** Long lists help nobody; the worst few are what get worked. */
const SHOW = 10

export default async function DiagnosticsPage({
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

  const [{ data: ledger, error }, { data: funnel }, { data: durations }] = await Promise.all([
    context.supabase.rpc('deal_ledger', {
      // Nothing here reads row.regions, so the field-definition lookup that
      // used to resolve the key is a round trip for an unused column.
      p_region_key: null,
    }),
    context.supabase.rpc('stage_funnel', { p_pipeline_id: null }),
    context.supabase.rpc('deal_stage_durations', { p_deal_id: null }),
  ])

  const rows = (ledger ?? []) as LedgerRow[]
  const reasons = lossReasons(rows, period)
  const coverage = lossCoverage(reasons)
  const steps = funnelSteps((funnel ?? []) as StageFunnelRow[])
  const ages = ageingBuckets(rows, today)
  const overdue = overdueDeals(rows, today)
  const undated = withoutCloseDate(rows)
  const stalled = stalledDeals(rows, (durations ?? []) as StageDurationRow[])

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
    return query ? `/reports/diagnostics?${query}` : '/reports/diagnostics'
  }

  return (
    <>
      <PageHeader
        title="Diagnostics"
        actions={
          <>
            <Link href="/reports/deals" className="btn-secondary">
              Deal ledger
            </Link>
            <Link href="/reports/performance" className="btn-secondary">
              Performance
            </Link>
            <Link href="/reports/charts" className="btn-secondary">
              Charts
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
        <span className="ml-auto text-xs text-slate-500">
          Losses cover {period.label}; ageing is always as of today.
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing to diagnose yet"
          description="These reports fill in as deals are worked, won and lost."
        />
      ) : (
        <div className="space-y-5">
          {/* ---------------------------------------------------------------- */}
          {/* Why deals are lost                                                */}
          {/* ---------------------------------------------------------------- */}
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">Why deals are lost</h2>
              {coverage.share !== null && (
                <p className="text-xs text-slate-500">
                  {formatPercent(coverage.share)} of lost deals have a reason recorded
                </p>
              )}
            </header>

            {reasons.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-400">
                Nothing lost in this period.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Reason</th>
                        <th className="text-right">Deals</th>
                        <th className="text-right">Share</th>
                        <th className="text-right">Value</th>
                        <th className="w-40" />
                      </tr>
                    </thead>
                    <tbody>
                      {reasons.map((reason) => (
                        <tr key={reason.reason ?? 'unrecorded'}>
                          <td
                            className={
                              reason.reason === null
                                ? 'text-slate-400 italic'
                                : 'font-medium text-slate-900'
                            }
                          >
                            {reason.label}
                          </td>
                          <td className="text-right text-slate-600">
                            {formatNumber(reason.deals)}
                          </td>
                          <td className="text-right text-slate-600">
                            {formatPercent(reason.share)}
                          </td>
                          <td className="text-right">
                            <MoneyTotals rows={reason.value} />
                          </td>
                          <td>
                            <div className="h-2 w-full rounded-full bg-slate-100">
                              <div
                                className={`h-2 rounded-full ${
                                  reason.reason === null ? 'bg-slate-300' : 'bg-rose-400'
                                }`}
                                style={{ width: `${Math.round(reason.share * 100)}%` }}
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/*
                  The row that decides whether the rest of the table is worth
                  reading. A loss-reason report built on a third of the losses
                  describes those losses, not the business.
                */}
                {coverage.missing > 0 && (
                  <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
                    {formatNumber(coverage.missing)} lost deal
                    {coverage.missing === 1 ? '' : 's'} carry no reason. Until that number is
                    small, read the reasons above as a picture of the losses somebody wrote up
                    rather than of the business. The reason is asked for on the deal form the
                    moment a deal is marked lost.
                  </p>
                )}
              </>
            )}
          </section>

          {/* ---------------------------------------------------------------- */}
          {/* Stage conversion                                                  */}
          {/* ---------------------------------------------------------------- */}
          <section className="card overflow-hidden">
            <header className="border-b border-slate-100 px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">Stage conversion</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Counted from recorded stage moves. Conversion is against the stage above, so the
                step that loses deals is the one that reads low.
              </p>
            </header>

            {steps.every((step) => step.reached === 0) ? (
              <p className="px-5 py-8 text-center text-sm text-slate-400">
                No stage movements recorded yet. Every move from here is counted.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th className="text-right">Reached</th>
                      <th className="text-right">From the stage above</th>
                      <th className="text-right">Still there</th>
                      <th className="text-right">Won after</th>
                      <th className="text-right">Lost after</th>
                      <th className="text-right">Median days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {steps.map((step) => (
                      <tr key={step.stage_id}>
                        <td className="font-medium text-slate-900">{step.stage_name}</td>
                        <td className="text-right text-slate-600">{formatNumber(step.reached)}</td>
                        <td className="text-right">
                          {step.conversion === null ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <span className={step.conversion < 0.5 ? 'text-amber-700' : undefined}>
                              {formatPercent(step.conversion)}
                            </span>
                          )}
                        </td>
                        <td className="text-right text-slate-600">
                          {formatNumber(step.still_there)}
                        </td>
                        <td className="text-right text-emerald-700">
                          {formatNumber(step.won_after)}
                        </td>
                        <td className="text-right text-rose-600">
                          {formatNumber(step.lost_after)}
                        </td>
                        <td className="text-right text-slate-600">
                          {step.median_days === null ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            formatNumber(Math.round(step.median_days))
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ---------------------------------------------------------------- */}
          {/* Ageing                                                            */}
          {/* ---------------------------------------------------------------- */}
          <div className="grid gap-5 lg:grid-cols-2">
            <section className="card overflow-hidden">
              <header className="border-b border-slate-100 px-5 py-4">
                <h2 className="text-base font-semibold text-slate-900">How old the pipeline is</h2>
                <p className="mt-0.5 text-xs text-slate-500">Open deals by age since created.</p>
              </header>

              <table className="table">
                <thead>
                  <tr>
                    <th>Age</th>
                    <th className="text-right">Deals</th>
                    <th className="text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {ages.map((bucket) => (
                    <tr key={bucket.label}>
                      <td className="text-slate-700">{bucket.label}</td>
                      <td className="text-right text-slate-600">{formatNumber(bucket.deals)}</td>
                      <td className="text-right">
                        {bucket.deals === 0 ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <MoneyTotals rows={bucket.value} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="card overflow-hidden">
              <header className="border-b border-slate-100 px-5 py-4">
                <h2 className="text-base font-semibold text-slate-900">Past their close date</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Open deals whose expected close has already passed.
                </p>
              </header>

              {overdue.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-slate-400">
                  Nothing is overdue.
                </p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Deal</th>
                      <th>Owner</th>
                      <th>Expected</th>
                      <th className="text-right">Days late</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overdue.slice(0, SHOW).map((entry) => (
                      <tr key={entry.row.deal_id}>
                        <td>
                          <Link
                            href={`/deals/${entry.row.deal_id}`}
                            className="font-medium text-slate-900 hover:text-brand-700"
                          >
                            {entry.row.name}
                          </Link>
                        </td>
                        <td className="text-slate-600">{entry.row.owner_name ?? '—'}</td>
                        <td className="text-slate-500">
                          {formatDay(entry.row.expected_close_date)}
                        </td>
                        <td className="text-right font-medium text-amber-700">
                          {formatNumber(entry.daysOverdue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
                {overdue.length > SHOW && `${formatNumber(overdue.length - SHOW)} more. `}
                {/*
                  A deal with no expected close cannot be overdue, which is not
                  the same as being on track — it is the same management problem
                  wearing a disguise, so it is counted rather than skipped.
                */}
                {undated.length > 0 &&
                  `${formatNumber(undated.length)} open deal${
                    undated.length === 1 ? ' has' : 's have'
                  } no expected close date at all, so nothing can call ${
                    undated.length === 1 ? 'it' : 'them'
                  } late.`}
              </p>
            </section>
          </div>

          {/* ---------------------------------------------------------------- */}
          {/* Stalled                                                           */}
          {/* ---------------------------------------------------------------- */}
          <section className="card overflow-hidden">
            <header className="border-b border-slate-100 px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">Gone quiet</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Open deals that have not changed stage in {STALLED_AFTER_DAYS} days or more,
                longest first.
              </p>
            </header>

            {stalled.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-400">
                Nothing has been sitting still that long.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Deal</th>
                      <th>Owner</th>
                      <th>Stage</th>
                      <th className="text-right">Days there</th>
                      <th className="text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stalled.slice(0, SHOW).map((entry) => (
                      <tr key={entry.row.deal_id}>
                        <td>
                          <Link
                            href={`/deals/${entry.row.deal_id}`}
                            className="font-medium text-slate-900 hover:text-brand-700"
                          >
                            {entry.row.name}
                          </Link>
                        </td>
                        <td className="text-slate-600">{entry.row.owner_name ?? '—'}</td>
                        <td className="text-slate-600">{entry.stageName}</td>
                        <td className="text-right font-medium text-slate-800">
                          {entry.sinceRecordingBegan && (
                            <span
                              className="mr-1 text-slate-400"
                              title="This deal was already in this stage when stage history began, so it has been there at least this long"
                            >
                              ≥
                            </span>
                          )}
                          {formatNumber(entry.days)}
                        </td>
                        <td className="text-right">
                          <MoneyTotals
                            rows={[{ value: Number(entry.row.value), currency: entry.row.currency }]}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {stalled.length > SHOW && (
              <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
                {formatNumber(stalled.length - SHOW)} more.
              </p>
            )}
          </section>
        </div>
      )}
    </>
  )
}
