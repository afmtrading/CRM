import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatCurrency, formatNumber } from '@/lib/format'
import type { PipelineRow, ProductMixReportRow } from '@/lib/database.types'
import { EmptyState, PageHeader } from '@/components/ui'

export const metadata = { title: 'Product mix · FLO CRM' }

// Summed live from the line items on every request, like the pipeline report:
// the number has to match what a manual sum would give.
export const dynamic = 'force-dynamic'

const STATUSES = [
  { value: '', label: 'Every deal' },
  { value: 'open', label: 'Open' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
]

export default async function ProductMixReport({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string; status?: string }>
}) {
  const params = await searchParams
  const context = await requireSession()

  const { data: pipelines } = await scoped(context, 'pipelines').select('*').order('name')

  const status = STATUSES.some((entry) => entry.value === params.status) ? params.status : ''

  const { data: report, error } = await context.supabase.rpc('report_product_mix', {
    p_pipeline_id: params.pipeline ?? null,
    p_status: status || null,
  })

  const rows = (report ?? []) as ProductMixReportRow[]

  /*
   * Rows arrive one per product per currency, and currencies are never added
   * together — a CAD subtotal and a EUR subtotal are two different tables, not
   * two numbers to sum.
   */
  const byCurrency = new Map<string, ProductMixReportRow[]>()
  for (const row of rows) {
    byCurrency.set(row.currency, [...(byCurrency.get(row.currency) ?? []), row])
  }

  const link = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    for (const [key, value] of Object.entries({ ...params, ...overrides })) {
      if (value) next.set(key, value)
    }
    const query = next.toString()
    return query ? `?${query}` : '/reports/product-mix'
  }

  return (
    <>
      <PageHeader
        title="Product mix"
        description="What the pipeline is actually made of, summed from deal line items. Each currency is reported on its own."
        actions={
          <Link href="/reports/pipeline-value" className="btn-secondary">
            Pipeline value
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Link
          href={link({ pipeline: undefined })}
          className={`rounded-full px-3 py-1 text-sm ${
            !params.pipeline
              ? 'bg-brand-700 text-white'
              : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
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

        <div className="ml-auto flex flex-wrap gap-2">
          {STATUSES.map((entry) => (
            <Link
              key={entry.value || 'all'}
              href={link({ status: entry.value || undefined })}
              className={`rounded-full px-3 py-1 text-sm ${
                (status ?? '') === entry.value
                  ? 'bg-slate-800 text-white'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {entry.label}
            </Link>
          ))}
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error.message}
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No line items yet"
          description="Add products to a deal and its mix appears here."
          action={
            <Link href="/products" className="btn-secondary">
              Go to products
            </Link>
          }
        />
      ) : (
        <div className="space-y-5">
          {[...byCurrency.entries()].map(([currency, currencyRows]) => {
            const sorted = [...currencyRows].sort(
              (a, b) => Number(b.total_value) - Number(a.total_value),
            )
            const total = sorted.reduce((sum, row) => sum + Number(row.total_value), 0)
            const weighted = sorted.reduce((sum, row) => sum + Number(row.weighted_value), 0)
            const margin = sorted.reduce((sum, row) => sum + Number(row.margin), 0)
            const max = Math.max(1, ...sorted.map((row) => Number(row.total_value)))

            return (
              <div key={currency} className="card overflow-hidden">
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                  <h2 className="text-sm font-semibold text-slate-800">{currency}</h2>
                  <p className="text-xs text-slate-500">
                    {formatCurrency(total, currency)} across {formatNumber(sorted.length)} product
                    {sorted.length === 1 ? '' : 's'}
                  </p>
                </header>

                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Category</th>
                        <th className="text-right">Deals</th>
                        <th className="text-right">Quantity</th>
                        <th className="text-right">Value</th>
                        <th className="text-right">Weighted</th>
                        <th className="text-right">Margin</th>
                        <th className="w-32" />
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((row) => (
                        <tr key={`${row.product_id}-${row.currency}`}>
                          <td>
                            <Link
                              href={`/products/${row.product_id}`}
                              className="font-medium text-slate-900 hover:text-brand-700"
                            >
                              {row.product_name}
                            </Link>
                          </td>
                          <td className="text-slate-500">{row.category ?? '—'}</td>
                          <td className="text-right text-slate-600">
                            {formatNumber(Number(row.deal_count))}
                          </td>
                          <td className="text-right text-slate-600">
                            {formatNumber(Number(row.total_quantity))}
                          </td>
                          <td className="text-right font-medium">
                            {formatCurrency(Number(row.total_value), currency)}
                          </td>
                          <td className="text-right text-slate-600">
                            {formatCurrency(Number(row.weighted_value), currency)}
                          </td>
                          <td
                            className={`text-right ${
                              Number(row.margin) < 0 ? 'text-red-600' : 'text-slate-600'
                            }`}
                          >
                            {formatCurrency(Number(row.margin), currency)}
                          </td>
                          <td>
                            <div className="h-2 w-full rounded-full bg-slate-100">
                              <div
                                className="h-2 rounded-full bg-brand-600"
                                style={{
                                  width: `${Math.round((Number(row.total_value) / max) * 100)}%`,
                                }}
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-50 font-semibold">
                        <td className="px-3 py-2" colSpan={4}>
                          Total
                        </td>
                        <td className="px-3 py-2 text-right">{formatCurrency(total, currency)}</td>
                        <td className="px-3 py-2 text-right">
                          {formatCurrency(weighted, currency)}
                        </td>
                        <td className="px-3 py-2 text-right">{formatCurrency(margin, currency)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
