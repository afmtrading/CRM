import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatDay, formatPercent } from '@/lib/format'
import { dealVisibility } from '@/lib/filters'
import type {
  DealRow,
  PipelineRow,
  SavedFilterRow,
  StageRow,
  UserRow,
} from '@/lib/database.types'
import { DealStatusBadge, EmptyState, PageHeader } from '@/components/ui'
import { CollapsibleGroup } from '@/components/collapsible'
import { Money, MoneyTotals } from '@/components/money'

import { DealFilters } from './deal-filters'
import { Kanban, type KanbanDeal } from './kanban'

/*
 * Never served from the route cache.
 *
 * These read per-request, per-tenant data behind an authenticated session, and
 * the App Router will happily hand back a previously rendered page otherwise —
 * which shows up as a deploy that went out and a screen that did not change.
 * The sales and invoice screens have said this since they were written; the
 * rest of the record pages were relying on it not happening.
 */
export const dynamic = 'force-dynamic'

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
      // The bar above the board runs in the order an admin arranged, not
      // alphabetically — see settings/pipelines. Archived ones are off it:
      // a retired pipeline has no deals on the board by construction, so its
      // tab would only ever open an empty column.
      scoped(context, 'pipelines').select('*').is('archived_at', null).order('order'),
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
    .is('archived_at', null)
    .order('order')

  const stageList = (stages ?? []) as StageRow[]
  const stageIds = stageList.map((stage) => stage.id)

  let dealQuery = scoped(context, 'deals')
    .select('*, contacts(id, first_name, last_name), companies(id, name)')
    // An administrator can see deleted deals — that is what makes the recycle
    // bin readable — so the board has to exclude them itself, or the one person
    // able to restore a deal is the one person who sees it twice.
    .is('deleted_at', null)
    .in('stage_id', stageIds.length > 0 ? stageIds : [NO_SUCH_ID])
    .order('position')
    .order('created_at', { ascending: false })

  if (params.owner) dealQuery = dealQuery.eq('owner_id', params.owner)

  /*
   * Status defaults to open, and on the board that has to mean "open, plus
   * whatever is sitting in a closing stage".
   *
   * A board is arranged by stage. Once dragging a card into Won actually marks
   * the deal won, filtering won deals out of the board makes the drop look like
   * a delete — the card vanishes and the Won column can never hold anything.
   * The column exists; what is in it should be visible.
   *
   * The list is arranged by nothing in particular, so there "Open deals" means
   * open deals and nothing else. Same filter, two honest readings.
   */
  const status = params.status ?? 'open'
  const visibility = dealVisibility(
    status,
    view,
    stageList.filter((stage) => stage.outcome !== 'open').map((stage) => stage.id),
  )

  if (visibility.kind === 'status') {
    dealQuery = dealQuery.eq('status', visibility.status)
  } else if (visibility.kind === 'open-or-closing') {
    dealQuery = dealQuery.or(
      `status.eq.open,stage_id.in.(${visibility.closingStageIds.join(',')})`,
    )
  }

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

  /*
   * The list view is the same board read downwards, so it is grouped the same
   * way. Stages with nothing in them are left out here — the kanban is where
   * you go to see an empty column; a run of headings saying "none" only makes
   * the deals that do exist harder to find.
   */
  const listGroups = stageList
    .map((stage) => ({
      stage,
      deals: dealRows.filter((deal) => deal.stage_id === stage.id),
    }))
    .filter((group) => group.deals.length > 0)

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
        description={<MoneyTotals rows={dealRows} />}
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
          canDelete={context.canWrite}
        />
      ) : listGroups.length === 0 ? (
        <div className="card py-10 text-center text-sm text-slate-500">
          No deals match this view.
        </div>
      ) : (
        <div className="space-y-8">
          {listGroups.map(({ stage, deals: stageDeals }) => {
            return (
              /*
                The same heading every other grouped list uses, and the same
                fold: a stage nobody is working this week goes away with one
                click and stays away.
              */
              <CollapsibleGroup
                key={stage.id}
                scope="deal"
                id={stage.id}
                label={stage.name}
                summary={
                  <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500">
                    <span>
                      {stageDeals.length} deal{stageDeals.length === 1 ? '' : 's'}
                    </span>
                    <span className="text-slate-300">·</span>
                    <MoneyTotals rows={stageDeals} />
                  </p>
                }
              >
                <div className="group-panel overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Deal</th>
                        <th>Value</th>
                        <th>Probability</th>
                        <th>Status</th>
                        <th>Owner</th>
                        <th>Expected close</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stageDeals.map((deal: DealRow & { companies: { name: string } | null }) => (
                        <tr key={deal.id} className="hover:bg-slate-50">
                          <td>
                            <Link
                              href={`/deals/${deal.id}`}
                              className="font-medium text-brand-700 hover:underline"
                            >
                              {deal.name}
                            </Link>
                            {deal.companies && (
                              <span className="ml-2 text-xs text-slate-400">
                                {deal.companies.name}
                              </span>
                            )}
                          </td>
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
                    </tbody>
                  </table>
                </div>
              </CollapsibleGroup>
            )
          })}
        </div>
      )}
    </>
  )
}
