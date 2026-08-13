'use client'

import { useOptimistic, useState, useTransition } from 'react'
import Link from 'next/link'

import { formatDay, formatPercent } from '@/lib/format'
import { Money, MoneyTotals } from '@/components/money'
import { TrashIcon } from '@/components/icons'
import type { DealRow, StageRow } from '@/lib/database.types'

import { deleteDealFromBoard, moveDealToStage } from './actions'

export interface KanbanDeal extends DealRow {
  contacts: { id: string; first_name: string; last_name: string } | null
  companies: { id: string; name: string } | null
}

/**
 * Kanban board with drag-between-stages (PRD 6.3).
 *
 * Uses the native HTML5 drag events rather than a drag-and-drop library: the
 * interaction is one card into one column, and a dependency would not earn its
 * place. The move is optimistic, so the card lands before the round trip.
 */
/** A move, or a removal. Both change which cards are on screen. */
type BoardChange = { kind: 'move'; dealId: string; stageId: string } | { kind: 'remove'; dealId: string }

export function Kanban({
  stages,
  deals,
  ownerNames,
  productNames,
  canDelete,
}: {
  stages: StageRow[]
  deals: KanbanDeal[]
  ownerNames: Record<string, string>
  /** Deal id → the distinct products on it, for the card. */
  productNames: Record<string, string[]>
  canDelete: boolean
}) {
  const [, startTransition] = useTransition()
  const [dragging, setDragging] = useState<string | null>(null)
  const [hoverStage, setHoverStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [optimisticDeals, applyChange] = useOptimistic(
    deals,
    (current: KanbanDeal[], change: BoardChange) =>
      change.kind === 'remove'
        ? current.filter((deal) => deal.id !== change.dealId)
        : current.map((deal) =>
            deal.id === change.dealId ? { ...deal, stage_id: change.stageId } : deal,
          ),
  )

  function onDrop(stageId: string) {
    const dealId = dragging
    setDragging(null)
    setHoverStage(null)
    if (!dealId) return

    const deal = optimisticDeals.find((d) => d.id === dealId)
    if (!deal || deal.stage_id === stageId) return

    startTransition(async () => {
      applyChange({ kind: 'move', dealId, stageId })
      const result = await moveDealToStage(dealId, stageId)
      if (result?.error) setError(result.error)
    })
  }

  /**
   * Clearing a finished card off the board.
   *
   * Confirmed rather than instant, because a card is a small target and this is
   * the only destructive thing on the page. It is not really destructive — the
   * deal goes to the recycle bin and an administrator can restore it — but the
   * person clicking has no way to know that unless it is said.
   */
  function onDelete(deal: KanbanDeal) {
    const ok = window.confirm(
      `Delete "${deal.name}"?\n\nIt moves to the recycle bin, where an administrator can restore it.`,
    )
    if (!ok) return

    startTransition(async () => {
      applyChange({ kind: 'remove', dealId: deal.id })
      const result = await deleteDealFromBoard(deal.id)
      if (result?.error) setError(result.error)
    })
  }

  return (
    <>
      {error && (
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex gap-3 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const stageDeals = optimisticDeals.filter((deal) => deal.stage_id === stage.id)

          return (
            <div
              key={stage.id}
              className={`flex w-72 shrink-0 flex-col rounded-lg border bg-slate-100/70 transition-colors ${
                hoverStage === stage.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200'
              }`}
              onDragOver={(event) => {
                event.preventDefault()
                setHoverStage(stage.id)
              }}
              onDragLeave={() => setHoverStage((current) => (current === stage.id ? null : current))}
              onDrop={() => onDrop(stage.id)}
            >
              <header className="flex items-baseline justify-between px-3 py-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-800">{stage.name}</h2>
                  <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-slate-500">
                    <span>{stageDeals.length}</span>
                    <span className="text-slate-300">·</span>
                    <MoneyTotals rows={stageDeals} />
                  </p>
                </div>
                <span className="text-xs text-slate-400">
                  {formatPercent(stage.default_probability)}
                </span>
              </header>

              <div className="flex-1 space-y-2 p-2">
                {stageDeals.map((deal) => (
                  <article
                    key={deal.id}
                    draggable
                    onDragStart={() => setDragging(deal.id)}
                    onDragEnd={() => {
                      setDragging(null)
                      setHoverStage(null)
                    }}
                    className={`cursor-grab rounded-xl border border-slate-200 bg-white p-3 shadow-sm active:cursor-grabbing ${
                      dragging === deal.id ? 'opacity-50' : ''
                    }`}
                  >
                    {/*
                      The owner sits top-right, opposite the name: it is the
                      thing people scan a board for after the name itself, and
                      at the bottom it competed with the dates for the same
                      glance.
                    */}
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/deals/${deal.id}`}
                        className="text-sm font-medium text-slate-900 hover:text-brand-700"
                      >
                        {deal.name}
                      </Link>

                      <div className="flex shrink-0 items-center gap-1">
                        {deal.owner_id && ownerNames[deal.owner_id] && (
                          <span
                            className="max-w-24 truncate rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600"
                            title={ownerNames[deal.owner_id]}
                          >
                            {ownerNames[deal.owner_id]}
                          </span>
                        )}

                        {/*
                          The quick way to clear a card that is finished with —
                          the thing that was missing once a card dropped into Won
                          stayed on the board instead of vanishing.
                        */}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => onDelete(deal)}
                            className="rounded-md p-1 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-600"
                            aria-label={`Delete ${deal.name}`}
                            title="Delete — recoverable from the recycle bin"
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    <p className="mt-1">
                      <Money
                        value={Number(deal.value ?? 0)}
                        currency={deal.currency}
                        amountClassName="text-sm font-semibold text-slate-700"
                      />
                    </p>

                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {deal.companies?.name ??
                        (deal.contacts
                          ? `${deal.contacts.first_name} ${deal.contacts.last_name}`.trim()
                          : '—')}
                    </p>

                    {/* What the deal is for, which is often the reason to open it. */}
                    {(productNames[deal.id]?.length ?? 0) > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {productNames[deal.id].slice(0, 3).map((name) => (
                          <span
                            key={name}
                            className="max-w-full truncate rounded bg-brand-50 px-1.5 py-0.5 text-[11px] text-brand-700"
                          >
                            {name}
                          </span>
                        ))}
                        {productNames[deal.id].length > 3 && (
                          <span
                            className="rounded px-1 py-0.5 text-[11px] text-slate-400"
                            title={productNames[deal.id].slice(3).join(', ')}
                          >
                            +{productNames[deal.id].length - 3}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                      <span title={deal.probability_overridden ? 'Probability set manually' : 'Stage default'}>
                        {formatPercent(deal.probability)}
                        {deal.probability_overridden && ' ✎'}
                      </span>
                      <span>{formatDay(deal.expected_close_date)}</span>
                    </div>
                  </article>
                ))}

                {stageDeals.length === 0 && (
                  <p className="px-1 py-6 text-center text-xs text-slate-400">Drop deals here</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
