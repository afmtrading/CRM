import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { dueLabel, formatCurrency } from '@/lib/format'
import type { ActivityRow, PipelineValueReportRow } from '@/lib/database.types'
import { PageHeader, StatCard } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const context = await requireSession()

  const [contacts, openDeals, myTasks, report] = await Promise.all([
    scoped(context, 'contacts').select('id', { count: 'exact', head: true }).is('duplicate_of_id', null),
    scoped(context, 'deals').select('value, currency').eq('status', 'open'),
    scoped(context, 'activities')
      .select('*')
      .eq('type', 'task')
      .eq('owner_id', context.user.id)
      .is('completed_at', null)
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(8),
    context.supabase.rpc('report_pipeline_value', { p_pipeline_id: null, p_owner_id: null }),
  ])

  const currency = context.organization.default_currency
  const dealRows = (openDeals.data ?? []) as { value: number; currency: string }[]
  const openValue = dealRows.reduce((sum, deal) => sum + Number(deal.value ?? 0), 0)

  const reportRows = (report.data ?? []) as PipelineValueReportRow[]
  const weighted = reportRows.reduce((sum, row) => sum + Number(row.weighted_value), 0)

  const tasks = (myTasks.data ?? []) as ActivityRow[]
  const overdue = tasks.filter((task) => dueLabel(task.due_date).tone === 'overdue').length

  return (
    <>
      <PageHeader
        title={`Welcome back, ${context.user.name?.split(' ')[0] || context.user.email}`}
        description={context.organization.name}
      />

      {error === 'admin-required' && (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          That page is only available to administrators.
        </p>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Contacts" value={String(contacts.count ?? 0)} href="/contacts" />
        <StatCard label="Open deals" value={String(dealRows.length)} href="/deals" />
        <StatCard
          label="Pipeline value"
          value={formatCurrency(openValue, currency)}
          hint={`${formatCurrency(weighted, currency)} weighted`}
          href="/reports/pipeline-value"
        />
        <StatCard
          label="My open tasks"
          value={String(tasks.length)}
          hint={overdue > 0 ? `${overdue} overdue` : undefined}
          href="/activities"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card">
          <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">My follow-ups</h2>
            <Link href="/activities" className="text-xs text-brand-700 hover:underline">
              All activities
            </Link>
          </header>
          <div className="p-4">
            {tasks.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing due. Log a task from any contact or deal.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {tasks.map((task) => {
                  const due = dueLabel(task.due_date)
                  const href =
                    task.related_to_type === 'contact'
                      ? `/contacts/${task.related_to_id}`
                      : task.related_to_type === 'company'
                        ? `/companies/${task.related_to_id}`
                        : `/deals/${task.related_to_id}`

                  return (
                    <li key={task.id} className="flex items-center justify-between gap-3 py-2">
                      <Link href={href} className="truncate text-sm text-slate-800 hover:text-brand-700">
                        {task.subject || 'Task'}
                      </Link>
                      <span
                        className={`shrink-0 text-xs ${
                          due.tone === 'overdue'
                            ? 'font-medium text-red-600'
                            : due.tone === 'today'
                              ? 'font-medium text-amber-600'
                              : 'text-slate-400'
                        }`}
                      >
                        {due.label}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="card">
          <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">Pipeline by stage</h2>
            <Link href="/reports/pipeline-value" className="text-xs text-brand-700 hover:underline">
              Full report
            </Link>
          </header>
          <div className="p-4">
            {reportRows.length === 0 ? (
              <p className="text-sm text-slate-500">No stages configured yet.</p>
            ) : (
              <ul className="space-y-2">
                {Object.entries(
                  reportRows.reduce<Record<string, number>>((acc, row) => {
                    acc[row.stage_name] = (acc[row.stage_name] ?? 0) + Number(row.total_value)
                    return acc
                  }, {}),
                ).map(([stage, total]) => (
                  <li key={stage} className="flex items-center justify-between text-sm">
                    <span className="text-slate-700">{stage}</span>
                    <span className="font-medium text-slate-900">{formatCurrency(total, currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  )
}
