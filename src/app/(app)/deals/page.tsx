import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatCurrency, formatDay, formatPercent } from '@/lib/format'
import type {
  DealRow,
  PipelineRow,
  SavedFilterRow,
  StageRow,
  UserRow,
} from '@/lib/database.types'
import { DealStatusBadge, EmptyState, PageHeader } from '@/components/ui'
import { Money } from '@/components/money'

import { DealFilters } from './deal-filters'
import { Kanban, type KanbanDeal } from './kanban'

export const metadata = { title: 'Deals · FLO CRM' }

/** Matches nothing, for the difference between "no filter" and "filtered to nothing". */
const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000'

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string
    pipeline?: string
    owner?: string
    product?: string
    status?: string
  }>
}) {
  const params = await searchParams
  const context = await requireSession()

  const view = params.view === 'list' ? 'list' : 'kanban'

  const [{ data: pipelines }, { data: users }, { data: products }, { data: savedViews }] =
    await Promise.all([
      scoped(context, 'pipelines').select('*').order('name'),
      scoped(context, 'users').select('*').order('name'),
      scoped(context, 'products').select('id, name').is('deleted_at', null).order('name'),
      /*
       * Yours plus anything a colleague chose to share — which is the row-level
       * policy on saved_filters verbatim, so it is not restated here. Repeating
       * it would be a second copy of the rule to keep in step with the first.
       */
      scoped(context, 'saved_filters').select('*').eq('entity_type', 'deal').order('name'),
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

  const { data: stages } = await scoped(context, 'stages')
    .select('*')
    .eq('pipeline_id', activePipeline.id)
    .order('order')

  const stageList = (stages ?? []) as StageRow[]
  const stageIds = stageList.map((stage) => stage.id)

  let dealQuery = scoped(context, 'deals')
    .select('*, contacts(id, first_name, last_name), companies(id, name)')
    .in('stage_id', stageIds.length > 0 ? stageIds : [NO_SUCH_ID])
    .order('position')
    .order('created_at', { ascending: false })

  if (params.owner) dealQuery = dealQuery.eq('owner_id', params.owner)

  /*
   * Status defaults to open on both views. A board of won and lost deals is a
   * report rather than a pipeline, and "all" is one choice away in the picker.
   */
  const status = params.status ?? 'open'
  if (status !== 'all') dealQuery = dealQuery.eq('status', status)

  /*
   * Product is a filter across a join, which no column predicate can express:
   * resolve it to deal ids first. An unmatched product yields an id that cannot
   * exist rather than no filter at all — silently showing everything would be
   * the wrong answer to "which deals include this".
   */
  if (params.product) {
    const { data: matches } = await scoped(context, 'deal_products')
      .select('deal_id')
      .eq('product_id', params.product)

    const matchedIds = [...new Set(((matches ?? []) as { deal_id: string }[]).map((m) => m.deal_id))]
    dealQuery = dealQuery.in('id', matchedIds.length ? matchedIds : [NO_SUCH_ID])
  }

  const { data: deals } = await dealQuery.limit(500)

  const dealRows = (deals ?? []) as KanbanDeal[]

  /*
   * What each deal is actually for. Fetched as one query keyed on the deals
   * already on screen rather than joined into the deal query, because a deal
   * with four line items would otherwise arrive four times and the board would
   * have to undo that.
   */
  const dealIds = dealRows.map((deal) => deal.id)
  const { data: lineItems } = dealIds.length
    ? await scoped(context, 'deal_products').select('deal_id, products(name)').in('deal_id', dealIds)
    : { data: [] }

  const productNames: Record<string, string[]> = {}
  for (const item of (lineItems ?? []) as {
    deal_id: string
    products: { name: string } | null
  }[]) {
    if (!item.products?.name) continue
    const names = (productNames[item.deal_id] ??= [])
    // The same product can appear on two lines at different prices; the board
    // wants to know what is being sold, not how it was itemised.
    if (!names.includes(item.products.name)) names.push(item.products.name)
  }
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
      </div>

      <DealFilters
        owners={userList.map((user) => ({ id: user.id, name: user.name || user.email }))}
        products={(products ?? []) as { id: string; name: string }[]}
        savedViews={(savedViews ?? []) as SavedFilterRow[]}
        currentUserId={context.user.id}
      />

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
        <Kanban
          stages={stageList}
          deals={dealRows}
          ownerNames={ownerNames}
          productNames={productNames}
        />
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
                  <td>
                    <Money
                      value={Number(deal.value ?? 0)}
                      currency={deal.currency}
                      amountClassName="font-medium"
                    />
                  </td>
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
