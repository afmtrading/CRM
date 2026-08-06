import Link from 'next/link'

import type { LifecycleStage, DealStatus } from '@/lib/database.types'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
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
    <div className="card flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-slate-800">{title}</p>
      {description && <p className="max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function StatCard({
  label,
  value,
  hint,
  href,
}: {
  label: string
  value: string
  hint?: string
  href?: string
}) {
  const body = (
    <div className="card p-4 transition-shadow hover:shadow">
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  )
  return href ? <Link href={href}>{body}</Link> : body
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
  open: 'bg-sky-100 text-sky-800',
  won: 'bg-emerald-100 text-emerald-800',
  lost: 'bg-red-100 text-red-700',
}

export function DealStatusBadge({ status }: { status: DealStatus }) {
  return <span className={`badge ${DEAL_STATUS_STYLES[status]}`}>{status}</span>
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
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
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}
