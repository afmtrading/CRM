import { currencySymbol, formatNumber, formatPercent } from '@/lib/format'
import { fraction, niceMax, ticks, type CycleBucket, type MonthBucket, type OwnerBar, type StageBucket } from '@/lib/charts'

/**
 * The report charts.
 *
 * Inline SVG rendered on the server: no charting library, no client JavaScript,
 * and the markup is the picture. Every number arrives already bucketed by
 * src/lib/charts.ts, so nothing here computes anything except geometry.
 *
 * Colour follows the rest of the app: won is emerald, lost is rose, open is
 * brand blue. They are also distinguishable by position and label, because a
 * chart that only works in colour does not work for everybody.
 */

/** Money short enough for an axis: $12k, $1.2M. */
export function compactMoney(value: number, currency: string): string {
  const symbol = currencySymbol(currency)
  const abs = Math.abs(value)

  if (abs >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${symbol}${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`
  return `${symbol}${Math.round(value)}`
}

function Legend({ items }: { items: { label: string; className: string }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className={`h-2.5 w-2.5 rounded-sm ${item.className}`} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

export function ChartEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 py-10 text-center text-sm text-slate-400">{children}</p>
  )
}

// -----------------------------------------------------------------------------
// Closed value per month
// -----------------------------------------------------------------------------

/**
 * Won and lost value by month, as paired columns.
 *
 * Paired rather than stacked: stacking would make the top of a column the sum
 * of won and lost, a number nobody wants. Side by side, the comparison the eye
 * makes is the right one.
 */
export function MonthlyColumns({
  buckets,
  currency,
}: {
  buckets: MonthBucket[]
  currency: string
}) {
  if (buckets.length === 0) {
    return <ChartEmpty>Nothing closed in this period.</ChartEmpty>
  }

  const max = niceMax(Math.max(...buckets.flatMap((bucket) => [bucket.won, bucket.lost])))

  // A viewBox rather than fixed pixels: the chart scales to its column without
  // any measuring, and the aspect ratio holds.
  const width = Math.max(320, buckets.length * 48)
  const height = 180
  const padding = { top: 8, right: 8, bottom: 22, left: 46 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const slot = plotWidth / buckets.length
  const barWidth = Math.min(14, slot / 2.6)

  return (
    <div className="space-y-3 px-5 py-4">
      <Legend
        items={[
          { label: 'Won', className: 'bg-emerald-500' },
          { label: 'Lost', className: 'bg-rose-400' },
        ]}
      />

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-48 w-full min-w-80"
          role="img"
          aria-label={`Won and lost value per month in ${currency}`}
        >
          {ticks(max).map((tick) => {
            const y = padding.top + plotHeight - fraction(tick, max) * plotHeight
            return (
              <g key={tick}>
                <line
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={y}
                  y2={y}
                  className="stroke-slate-200"
                  strokeWidth={1}
                />
                <text
                  x={padding.left - 6}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-slate-400 text-[9px]"
                >
                  {compactMoney(tick, currency)}
                </text>
              </g>
            )
          })}

          {buckets.map((bucket, index) => {
            const centre = padding.left + slot * index + slot / 2
            const wonHeight = fraction(bucket.won, max) * plotHeight
            const lostHeight = fraction(bucket.lost, max) * plotHeight

            return (
              <g key={bucket.key}>
                <rect
                  x={centre - barWidth - 1}
                  y={padding.top + plotHeight - wonHeight}
                  width={barWidth}
                  height={wonHeight}
                  rx={1.5}
                  className="fill-emerald-500"
                >
                  <title>
                    {bucket.label}: {formatNumber(bucket.wonCount)} won,{' '}
                    {compactMoney(bucket.won, currency)}
                  </title>
                </rect>
                <rect
                  x={centre + 1}
                  y={padding.top + plotHeight - lostHeight}
                  width={barWidth}
                  height={lostHeight}
                  rx={1.5}
                  className="fill-rose-400"
                >
                  <title>
                    {bucket.label}: {formatNumber(bucket.lostCount)} lost,{' '}
                    {compactMoney(bucket.lost, currency)}
                  </title>
                </rect>

                {/* Every other label when the months are tight, so they stay readable. */}
                {(buckets.length <= 12 || index % 2 === 0) && (
                  <text
                    x={centre}
                    y={height - 6}
                    textAnchor="middle"
                    className="fill-slate-400 text-[9px]"
                  >
                    {bucket.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Owners side by side
// -----------------------------------------------------------------------------

export function OwnerBars({ bars, currency }: { bars: OwnerBar[]; currency: string }) {
  if (bars.length === 0) return <ChartEmpty>No deals in this currency.</ChartEmpty>

  const max = niceMax(Math.max(...bars.flatMap((bar) => [bar.won, bar.lost, bar.open])))

  return (
    <div className="space-y-4 px-5 py-4">
      <Legend
        items={[
          { label: 'Won', className: 'bg-emerald-500' },
          { label: 'Lost', className: 'bg-rose-400' },
          { label: 'Open', className: 'bg-brand-500' },
        ]}
      />

      <ul className="space-y-3">
        {bars.map((bar) => (
          <li key={bar.ownerId ?? 'unassigned'}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-slate-800">{bar.label}</span>
              <span className="text-xs text-slate-500">
                {compactMoney(bar.won, currency)} won
                {bar.winRate !== null && ` · ${formatPercent(bar.winRate)} win rate`}
              </span>
            </div>

            <div className="mt-1 space-y-1">
              {[
                { key: 'won', value: bar.won, className: 'bg-emerald-500' },
                { key: 'lost', value: bar.lost, className: 'bg-rose-400' },
                { key: 'open', value: bar.open, className: 'bg-brand-500' },
              ].map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-slate-100">
                    <div
                      className={`h-2 rounded-full ${row.className}`}
                      style={{ width: `${fraction(row.value, max) * 100}%` }}
                      title={`${row.key}: ${compactMoney(row.value, currency)}`}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right text-[11px] text-slate-400">
                    {compactMoney(row.value, currency)}
                  </span>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// -----------------------------------------------------------------------------
// How long deals take
// -----------------------------------------------------------------------------

/**
 * Cycle length, won against lost.
 *
 * The reading worth having is the comparison: if the lost bars sit to the right
 * of the won ones, deals are being chased long after they were gone.
 */
export function CycleHistogram({ buckets }: { buckets: CycleBucket[] }) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.won + bucket.lost, 0)
  if (total === 0) return <ChartEmpty>Nothing has closed yet, so nothing has a length.</ChartEmpty>

  const max = Math.max(...buckets.map((bucket) => bucket.won + bucket.lost))

  return (
    <div className="space-y-4 px-5 py-4">
      <Legend
        items={[
          { label: 'Won', className: 'bg-emerald-500' },
          { label: 'Lost', className: 'bg-rose-400' },
        ]}
      />

      <ul className="space-y-2">
        {buckets.map((bucket) => (
          <li key={bucket.label} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-slate-500">{bucket.label}</span>

            {/* Stacked here, unlike the monthly columns: the total is the
                number of deals that took this long, which is meaningful. */}
            <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className="bg-emerald-500"
                style={{ width: `${fraction(bucket.won, max) * 100}%` }}
                title={`${formatNumber(bucket.won)} won`}
              />
              <div
                className="bg-rose-400"
                style={{ width: `${fraction(bucket.lost, max) * 100}%` }}
                title={`${formatNumber(bucket.lost)} lost`}
              />
            </div>

            <span className="w-14 shrink-0 text-right text-xs text-slate-400">
              {formatNumber(bucket.won + bucket.lost)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Where the open pipeline sits
// -----------------------------------------------------------------------------

export function StageBars({ stages, currency }: { stages: StageBucket[]; currency: string }) {
  if (stages.length === 0) return <ChartEmpty>Nothing open in this currency.</ChartEmpty>

  const max = niceMax(Math.max(...stages.map((stage) => stage.value)))
  const pipelines = new Set(stages.map((stage) => stage.pipeline))

  return (
    <div className="space-y-2 px-5 py-4">
      <ul className="space-y-2.5">
        {stages.map((stage) => (
          <li key={stage.stageId}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-slate-700">
                {stage.label}
                {pipelines.size > 1 && (
                  <span className="ml-2 text-xs text-slate-400">{stage.pipeline}</span>
                )}
              </span>
              <span className="text-xs text-slate-500">
                {formatNumber(stage.count)} · {compactMoney(stage.value, currency)}
              </span>
            </div>
            <div className="mt-1 h-2 w-full rounded-full bg-slate-100">
              <div
                className="h-2 rounded-full bg-brand-600"
                style={{ width: `${fraction(stage.value, max) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
