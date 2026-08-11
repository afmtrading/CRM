import Link from 'next/link'

import type { LifecycleStage, DealStatus } from '@/lib/database.types'
import { initials } from '@/lib/format'
import { TrendingUpIcon, type IconComponent } from '@/components/icons'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  /** Usually a line of text, but totals need their own markup to be coloured. */
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="card flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-slate-800">{title}</p>
      {description && <p className="max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/**
 * The tinted-square palette used by stat cards. Named by intent rather than by
 * colour so a card's meaning survives a palette change.
 */
export type StatTone = 'brand' | 'blue' | 'amber' | 'red' | 'violet'

const STAT_TONES: Record<StatTone, string> = {
  brand: 'bg-brand-600 text-white',
  blue: 'bg-blue-500 text-white',
  amber: 'bg-amber-500 text-white',
  red: 'bg-red-500 text-white',
  violet: 'bg-violet-500 text-white',
}

export function StatCard({
  label,
  value,
  hint,
  href,
  icon: Icon,
  tone = 'brand',
  trend,
}: {
  label: string
  value: string
  hint?: string
  href?: string
  icon?: IconComponent
  tone?: StatTone
  /** Positive/negative movement shown under the value, e.g. "+3 this month". */
  trend?: { label: string; direction: 'up' | 'down' | 'flat' }
}) {
  const body = (
    <div className={`${href ? 'card-interactive' : 'card'} h-full p-5`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{value}</p>
        </div>
        {Icon && (
          <span className={`icon-chip ${STAT_TONES[tone]}`}>
            <Icon className="h-5 w-5" />
          </span>
        )}
      </div>

      {trend && (
        <p
          className={`mt-2 inline-flex items-center gap-1 text-xs font-medium ${
            trend.direction === 'up'
              ? 'text-emerald-600'
              : trend.direction === 'down'
                ? 'text-red-600'
                : 'text-slate-400'
          }`}
        >
          {trend.direction !== 'flat' && (
            <TrendingUpIcon
              className={`h-3.5 w-3.5 ${trend.direction === 'down' ? '-scale-y-100' : ''}`}
            />
          )}
          {trend.label}
        </p>
      )}

      {hint && <p className="mt-2 text-xs text-slate-500">{hint}</p>}
    </div>
  )
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  )
}

/** Row of stat cards — the pattern that opens every list page. */
export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{children}</div>
}

const AVATAR_TONES = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-violet-100 text-violet-700',
  'bg-rose-100 text-rose-700',
  'bg-cyan-100 text-cyan-700',
]

/**
 * Monogram avatar. The tint is derived from the name so the same person keeps
 * the same colour across pages without storing anything.
 */
export function Avatar({ name, className = 'h-9 w-9' }: { name: string; className?: string }) {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash + name.charCodeAt(i)) % AVATAR_TONES.length
  return <span className={`avatar ${className} ${AVATAR_TONES[hash]}`}>{initials(name) || '?'}</span>
}

/**
 * Lead score as a small stepped meter plus the raw number. The bars give the
 * list a shape to scan; the number stays for anyone who needs the real value.
 */
export function ScoreMeter({ score }: { score: number }) {
  const level = score >= 75 ? 3 : score >= 40 ? 2 : score > 0 ? 1 : 0
  const tone = level >= 3 ? 'bg-emerald-500' : level === 2 ? 'bg-amber-500' : 'bg-slate-400'

  return (
    <span className="inline-flex items-center gap-2" title={`Lead score ${score}`}>
      <span className="flex items-end gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`w-1 rounded-full ${i < level ? tone : 'bg-slate-200'}`}
            style={{ height: `${8 + i * 4}px` }}
          />
        ))}
      </span>
      <span className="text-xs font-medium text-slate-600">{score}</span>
    </span>
  )
}

const LIFECYCLE_STYLES: Record<LifecycleStage, string> = {
  lead: 'bg-slate-100 text-slate-700',
  qualified: 'bg-amber-100 text-amber-800',
  customer: 'bg-emerald-100 text-emerald-800',
  other: 'bg-slate-100 text-slate-600',
}

export function LifecycleBadge({ stage }: { stage: LifecycleStage }) {
  return <span className={`badge ${LIFECYCLE_STYLES[stage]}`}>{stage}</span>
}

const DEAL_STATUS_STYLES: Record<DealStatus, string> = {
  open: 'bg-blue-100 text-blue-700',
  won: 'bg-emerald-100 text-emerald-700',
  lost: 'bg-red-100 text-red-700',
}

export function DealStatusBadge({ status }: { status: DealStatus }) {
  return <span className={`badge ${DEAL_STATUS_STYLES[status]}`}>{status}</span>
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700" role="alert">
      {children}
    </p>
  )
}

export function Section({
  title,
  actions,
  children,
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="card">
      <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {actions}
      </header>
      <div className="p-5">{children}</div>
    </section>
  )
}
