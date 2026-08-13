import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatCurrency, formatNumber } from '@/lib/format'
import type { PipelineRow, PipelineValueReportRow, UserRow } from '@/lib/database.types'
import { EmptyState, PageHeader } from '@/components/ui'

export const metadata = { title: 'Pipeline value · FLO CRM' }

// The report is computed from the deals table on every request (PRD 6.8: the
// number must always match a manual sum, so nothing here is cached).
export const dynamic = 'force-dynamic'

export default async function PipelineValueReport({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string; owner?: string }>
}) {
  const params = await searchParams
  const context = await requireSession()

  const [{ data: pipelines }, { data: users }] = await Promise.all([
    scoped(context, 'pipelines').select('*').order('name'),
    scoped(context, 'users').select('*').order('name'),
  ])

  const { data: report, error } = await context.supabase.rpc('report_pipeline_value', {
    p_pipeline_id: params.pipeline ?? null,
    p_owner_id: params.owner ?? null,
  })

  const rows = (report ?? []) as PipelineValueReportRow[]
  const currency = context.organization.default_currency

  // Roll the per-owner rows up per stage; the RPC returns the finer grain so
  // the by-owner breakdown is available without a second query.
  const byStage = new Map<
    string,
    { name: string; order: number; pipeline: string; count: number; total: number; weighted: number }
  >()

  for (const row of rows) {
    const existing = byStage.get(row.stage_id)
    if (existing) {
      existing.count += Number(row.deal_count)
      existing.total += Number(row.total_value)
      existing.weighted += Number(row.weighted_value)
    } else {
      byStage.set(row.stage_id, {
        name: row.stage_name,
        order: row.stage_order,
        pipeline: row.pipeline_name,
        count: Number(row.deal_count),
        total: Number(row.total_value),
        weighted: Number(row.weighted_value),
      })
    }
  }

  const stageRows = [...byStage.values()].sort(
    (a, b) => a.pipeline.localeCompare(b.pipeline) || a.order - b.order,
  )

  const byOwner = new Map<string, { name: string; count: number; total: number; weighted: number }>()
  for (const row of rows) {
    if (!row.owner_id || Number(row.deal_count) === 0) continue
    const existing = byOwner.get(row.owner_id)
    if (existing) {
      existing.count += Number(row.deal_count)
      existing.total += Number(row.total_value)
      existing.weighted += Number(row.weighted_value)
    } else {
      byOwner.set(row.owner_id, {
        name: row.owner_name ?? 'Unassigned',
        count: Number(row.deal_count),
        total: Number(row.total_value),
        weighted: Number(row.weighted_value),
      })
    }
  }

  const grandTotal = stageRows.reduce((sum, row) => sum + row.total, 0)
  const grandWeighted = stageRows.reduce((sum, row) => sum + row.weighted, 0)
  const maxTotal = Math.max(1, ...stageRows.map((row) => row.total))

  const link = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    for (const [key, value] of Object.entries({ ...params, ...overrides })) {
      if (value) next.set(key, value)
    }
    const query = next.toString()
    return query ? `?${query}` : '/reports/pipeline-value'
  }

  return (
    <>
      <PageHeader
        title="Pipeline value"
        description="Open deals only, summed live from the deal records — no cached totals."
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

      <div className="mb-4 flex flex-wrap gap-2">
        <Link
          href={link({ pipeline: undefined })}
          className={`rounded-full px-3 py-1 text-sm ${
            !params.pipeline ? 'bg-brand-700 text-white' : 'border border-slate-200 bg-white text-slate-600'
          }`}
        >
          All pipelines
        </Link>
        {((pipelines ?? []) as PipelineRow[]).map((pipeline) => (
          <Link
            key={pipeline.id}
            href={link({ pipeline: pipeline.id })}
            className={`rounded-full px-3 py-1 text-sm ${
              params.pipeline === pipeline.id
                ? 'bg-brand-700 text-white'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {pipeline.name}
          </Link>
        ))}

        <div className="ml-auto">
          <form>
            {params.pipeline && <input type="hidden" name="pipeline" value={params.pipeline} />}
            <select name="owner" className="input" defaultValue={params.owner ?? ''}>
              <option value="">All owners</option>
              {((users ?? []) as UserRow[]).map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name || user.email}
                </option>
              ))}
            </select>
            <noscript>
              <button type="submit" className="btn-secondary ml-2">
                Filter
              </button>
            </noscript>
          </form>
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error.message}
        </p>
      )}

      {stageRows.length === 0 ? (
        <EmptyState title="No stages to report on" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="card overflow-hidden lg:col-span-2">
            <header className="border-b border-slate-100 px-5 py-4">
              <h2 className="text-sm font-semibold text-slate-800">By stage</h2>
            </header>
            <table className="table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th className="text-right">Deals</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">Weighted</th>
                  <th className="w-40" />
                </tr>
              </thead>
              <tbody>
                {stageRows.map((row) => (
                  <tr key={`${row.pipeline}-${row.name}`}>
                    <td>
                      <span className="font-medium text-slate-800">{row.name}</span>
                      {!params.pipeline && (
                        <span className="ml-2 text-xs text-slate-400">{row.pipeline}</span>
                      )}
                    </td>
                    <td className="text-right text-slate-600">{formatNumber(row.count)}</td>
                    <td className="text-right font-medium">{formatCurrency(row.total, currency)}</td>
                    <td className="text-right text-slate-600">{formatCurrency(row.weighted, currency)}</td>
                    <td>
                      <div className="h-2 w-full rounded-full bg-slate-100">
                        <div
                          className="h-2 rounded-full bg-brand-600"
                          style={{ width: `${Math.round((row.total / maxTotal) * 100)}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50 font-semibold">
                  <td className="px-3 py-2">Total</td>
                  <td className="px-3 py-2 text-right">
                    {formatNumber(stageRows.reduce((sum, row) => sum + row.count, 0))}
                  </td>
                  <td className="px-3 py-2 text-right">{formatCurrency(grandTotal, currency)}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(grandWeighted, currency)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="card overflow-hidden">
            <header className="border-b border-slate-100 px-5 py-4">
              <h2 className="text-sm font-semibold text-slate-800">By owner</h2>
            </header>
            {byOwner.size === 0 ? (
              <p className="p-4 text-sm text-slate-500">No open deals assigned.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th className="text-right">Deals</th>
                    <th className="text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byOwner.values()]
                    .sort((a, b) => b.total - a.total)
                    .map((row) => (
                      <tr key={row.name}>
                        <td className="text-slate-800">{row.name}</td>
                        <td className="text-right text-slate-600">{formatNumber(row.count)}</td>
                        <td className="text-right font-medium">{formatCurrency(row.total, currency)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  )
}
