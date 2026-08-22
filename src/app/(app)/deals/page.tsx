import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatCurrency, formatDay, formatPercent } from '@/lib/format'
import type { DealRow, PipelineRow, StageRow, UserRow } from '@/lib/database.types'
import { DealStatusBadge, EmptyState, PageHeader } from '@/components/ui'

import { Kanban, type KanbanDeal } from './kanban'

export const metadata = { title: 'Deals · FLO CRM' }

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; pipeline?: string; owner?: string; status?: string }>
}) {
  const params = await searchParams
  const context = await requireSession()

  const view = params.view === 'list' ? 'list' : 'kanban'

  /*
   * Stages are fetched for the whole organization rather than for the active
   * pipeline. Which pipeline is active is only known after the pipelines query
   * returns, so scoping the stage query to it forced three sequential round
   * trips (pipelines -> stages -> deals) in front of the board. Stages are a
   * handful of rows per pipeline, so reading all of them and picking the
   * active pipeline's in memory costs less than the extra trip it removes.
   */
  const [{ data: pipelines }, { data: users }, { data: allStages }] = await Promise.all([
    scoped(context, 'pipelines').select('*').order('name'),
    scoped(context, 'users').select('*').order('name'),
    scoped(context, 'stages').select('*').order('order'),
  ])

  const pipelineList = (pipelines ?? []) as PipelineRow[]
  const activePipeline =
    pipelineList.find((pipeline) => pipeline.id === params.pipeline) ??
    pipelineList.find((pipeline) => pipeline.is_default) ??
    pipelineList[0]

  if (!activePipeline) {
    return (
      <>
        <PageHeader title="Deals" />
        <EmptyState
          title="No pipeline yet"
          description="Every organization needs at least one pipeline with stages before deals can exist."
          action={
            context.isAdmin ? (
              <Link href="/settings/pipelines" className="btn-primary">
                Set up a pipeline
              </Link>
            ) : undefined
          }
        />
      </>
    )
  }

  const stageList = ((allStages ?? []) as StageRow[]).filter(
    (stage) => stage.pipeline_id === activePipeline.id,
  )
  const stageIds = stageList.map((stage) => stage.id)

  let dealQuery = scoped(context, 'deals')
    .select('*, contacts(id, first_name, last_name), companies(id, name)')
    .in('stage_id', stageIds.length > 0 ? stageIds : ['00000000-0000-0000-0000-000000000000'])
    .order('position')
    .order('created_at', { ascending: false })

  if (params.owner) dealQuery = dealQuery.eq('owner_id', params.owner)
  if (params.status) dealQuery = dealQuery.eq('status', params.status)
  else if (view === 'kanban') dealQuery = dealQuery.eq('status', 'open')

  const { data: deals } = await dealQuery.limit(500)

  const dealRows = (deals ?? []) as KanbanDeal[]
  const userList = (users ?? []) as UserRow[]
  const ownerNames = Object.fromEntries(userList.map((user) => [user.id, user.name || user.email]))
  const stageNames = new Map(stageList.map((stage) => [stage.id, stage.name]))

  const totalValue = dealRows.reduce((sum, deal) => sum + Number(deal.value ?? 0), 0)

  const linkParams = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    const merged = { ...params, ...overrides }
    for (const [key, value] of Object.entries(merged)) {
      if (value) next.set(key, value)
    }
    return `?${next.toString()}`
  }

  return (
    <>
      <PageHeader
        title="Deals"
        description={`${dealRows.length} deal${dealRows.length === 1 ? '' : 's'} · ${formatCurrency(
          totalValue,
          context.organization.default_currency,
        )}`}
        actions={
          <>
            <div className="inline-flex overflow-hidden rounded-md border border-slate-300">
              <Link
                href={linkParams({ view: undefined })}
                className={`px-3 py-1.5 text-sm ${view === 'kanban' ? 'bg-slate-100 font-medium text-slate-900' : 'bg-white text-slate-600'}`}
              >
                Kanban
              </Link>
              <Link
                href={linkParams({ view: 'list' })}
                className={`border-l border-slate-300 px-3 py-1.5 text-sm ${view === 'list' ? 'bg-slate-100 font-medium text-slate-900' : 'bg-white text-slate-600'}`}
              >
                List
              </Link>
            </div>
            <Link href="/deals/new" className="btn-primary">
              New deal
            </Link>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {pipelineList.length > 1 &&
          pipelineList.map((pipeline) => (
            <Link
              key={pipeline.id}
              href={linkParams({ pipeline: pipeline.id })}
              className={`rounded-full px-3 py-1 text-sm ${
                pipeline.id === activePipeline.id
                  ? 'bg-brand-700 text-white'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {pipeline.name}
            </Link>
          ))}

        <div className="ml-auto flex gap-2">
          <Link
            href={linkParams({ owner: undefined })}
            className={`rounded-md px-2 py-1 text-sm ${!params.owner ? 'font-medium text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}
          >
            All owners
          </Link>
          <Link
            href={linkParams({ owner: context.user.id })}
            className={`rounded-md px-2 py-1 text-sm ${params.owner === context.user.id ? 'font-medium text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}
          >
            Mine
          </Link>
        </div>
      </div>

      {stageList.length === 0 ? (
        <EmptyState
          title={`"${activePipeline.name}" has no stages`}
          action={
            context.isAdmin ? (
              <Link href="/settings/pipelines" className="btn-primary">
                Add stages
              </Link>
            ) : undefined
          }
        />
      ) : view === 'kanban' ? (
        <Kanban stages={stageList} deals={dealRows} ownerNames={ownerNames} />
      ) : (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>Deal</th>
                <th>Stage</th>
                <th>Value</th>
                <th>Probability</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Expected close</th>
              </tr>
            </thead>
            <tbody>
              {dealRows.map((deal: DealRow & { companies: { name: string } | null }) => (
                <tr key={deal.id} className="hover:bg-slate-50">
                  <td>
                    <Link href={`/deals/${deal.id}`} className="font-medium text-brand-700 hover:underline">
                      {deal.name}
                    </Link>
                    {deal.companies && (
                      <span className="ml-2 text-xs text-slate-400">{deal.companies.name}</span>
                    )}
                  </td>
                  <td>{stageNames.get(deal.stage_id) ?? '—'}</td>
                  <td className="font-medium">{formatCurrency(deal.value, deal.currency)}</td>
                  <td>
                    {formatPercent(deal.probability)}
                    {deal.probability_overridden && (
                      <span className="ml-1 text-xs text-slate-400" title="Manually overridden">
                        ✎
                      </span>
                    )}
                  </td>
                  <td>
                    <DealStatusBadge status={deal.status} />
                  </td>
                  <td className="text-slate-600">
                    {deal.owner_id ? (ownerNames[deal.owner_id] ?? '—') : '—'}
                  </td>
                  <td className="text-slate-500">{formatDay(deal.expected_close_date)}</td>
                </tr>
              ))}
              {dealRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-slate-500">
                    No deals in this pipeline yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
