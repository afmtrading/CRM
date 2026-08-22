import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatCurrency } from '@/lib/format'
import type { ActivityRow, PipelineValueReportRow } from '@/lib/database.types'
import { PageHeader, Section, StatCard, StatGrid } from '@/components/ui'
import { ContactsIcon, CurrencyIcon, DealsIcon } from '@/components/icons'
import { DueDate } from '@/components/due-date'
import { MailboxNudge } from '@/components/mailbox-nudge'
import { isGoogleConfigured } from '@/lib/env'
import { isTokenKeyConfigured } from '@/lib/crypto'

import { OpenTasksCard } from './open-tasks-card'

export const dynamic = 'force-dynamic'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const context = await requireSession()

  // Only worth asking when connecting is actually possible: the feature has to
  // be configured, and a read-only role cannot connect one at all.
  const mailboxOffered = isGoogleConfigured() && isTokenKeyConfigured() && context.canWrite

  /*
   * Open deals are not fetched here. report_pipeline_value already aggregates
   * deal_count and total_value over exactly these deals — same organization,
   * same status, same deleted_at filter — in a call this page was making
   * anyway. The row fetch existed only to take a length and sum one column,
   * and grew with the pipeline.
   */
  const [contacts, myTasks, report, mailboxes] = await Promise.all([
    scoped(context, 'contacts')
      .select('id', { count: 'exact', head: true })
      .is('duplicate_of_id', null)
      .is('deleted_at', null),
    scoped(context, 'activities')
      .select('*')
      .eq('type', 'task')
      .eq('owner_id', context.user.id)
      .is('completed_at', null)
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(8),
    context.supabase.rpc('report_pipeline_value', { p_pipeline_id: null, p_owner_id: null }),
    mailboxOffered
      ? scoped(context, 'mailbox_connections').select('id, status').eq('user_id', context.user.id)
      : Promise.resolve({ data: [] as { id: string; status: string }[] }),
  ])

  const currency = context.organization.default_currency

  const reportRows = (report.data ?? []) as PipelineValueReportRow[]
  const weighted = reportRows.reduce((sum, row) => sum + Number(row.weighted_value), 0)
  // One row per (stage, owner) over open, undeleted deals, so these are the
  // same two numbers the per-deal fetch used to produce.
  const openCount = reportRows.reduce((sum, row) => sum + Number(row.deal_count), 0)
  const openValue = reportRows.reduce((sum, row) => sum + Number(row.total_value), 0)

  const tasks = (myTasks.data ?? []) as ActivityRow[]

  /*
   * Nothing at all once a mailbox is syncing. Somebody whose only connection
   * has expired is shown the reconnect nudge instead of the connect one — the
   * weekly expiry is silent otherwise, and a mailbox that quietly stopped
   * collecting mail is worse than one that was never connected.
   */
  const connections = (mailboxes.data ?? []) as { id: string; status: string }[]
  const nudge = !mailboxOffered
    ? null
    : connections.some((connection) => connection.status === 'active')
      ? null
      : connections.some((connection) => connection.status === 'needs_reauth')
        ? ('reconnect' as const)
        : connections.length === 0
          ? ('connect' as const)
          : null

  return (
    <>
      <PageHeader
        title={`Welcome back, ${context.user.name?.split(' ')[0] || context.user.email}`}
        description={context.organization.name}
      />

      {nudge && <MailboxNudge nudge={nudge} />}

      {error === 'admin-required' && (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          That page is only available to administrators.
        </p>
      )}

      <StatGrid>
        <StatCard
          label="Contacts"
          value={String(contacts.count ?? 0)}
          href="/contacts"
          icon={ContactsIcon}
          tone="blue"
        />
        <StatCard
          label="Open deals"
          value={String(openCount)}
          href="/deals"
          icon={DealsIcon}
          tone="brand"
        />
        <StatCard
          label="Pipeline value"
          value={formatCurrency(openValue, currency)}
          hint={`${formatCurrency(weighted, currency)} weighted`}
          href="/reports/pipeline-value"
          icon={CurrencyIcon}
          tone="violet"
        />
        <OpenTasksCard dueDates={tasks.map((task) => task.due_date)} />
      </StatGrid>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          title="My follow-ups"
          actions={
            <Link href="/activities" className="text-xs font-medium text-brand-700 hover:underline">
              All activities
            </Link>
          }
        >
          {tasks.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing due. Log a task from any contact or deal.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {tasks.map((task) => {
                const href =
                  task.related_to_type === 'contact'
                    ? `/contacts/${task.related_to_id}`
                    : task.related_to_type === 'company'
                      ? `/companies/${task.related_to_id}`
                      : `/deals/${task.related_to_id}`

                return (
                  <li key={task.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
                    <Link href={href} className="truncate text-sm text-slate-800 hover:text-brand-700">
                      {task.subject || 'Task'}
                    </Link>
                    <DueDate value={task.due_date} className="shrink-0 text-xs" />
                  </li>
                )
              })}
            </ul>
          )}
        </Section>

        <Section
          title="Pipeline by stage"
          actions={
            <Link
              href="/reports/pipeline-value"
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              Full report
            </Link>
          }
        >
          {reportRows.length === 0 ? (
            <p className="text-sm text-slate-500">No stages configured yet.</p>
          ) : (
            (() => {
              const byStage = Object.entries(
                reportRows.reduce<Record<string, number>>((acc, row) => {
                  acc[row.stage_name] = (acc[row.stage_name] ?? 0) + Number(row.total_value)
                  return acc
                }, {}),
              )
              // Bars are relative to the largest stage, so the shape of the
              // pipeline reads at a glance rather than needing the numbers.
              const peak = Math.max(...byStage.map(([, total]) => total), 1)

              return (
                <ul className="space-y-3.5">
                  {byStage.map(([stage, total]) => (
                    <li key={stage}>
                      <div className="mb-1.5 flex items-center justify-between text-sm">
                        <span className="text-slate-700">{stage}</span>
                        <span className="font-semibold text-slate-900">
                          {formatCurrency(total, currency)}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{ width: `${Math.max((total / peak) * 100, 2)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )
            })()
          )}
        </Section>
      </div>
    </>
  )
}
