'use client'

import { useOptimistic, useState, useTransition } from 'react'
import Link from 'next/link'

import { formatCurrency, formatDate, formatPercent } from '@/lib/format'
import type { DealRow, StageRow } from '@/lib/database.types'

import { moveDealToStage } from './actions'

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
export function Kanban({
  stages,
  deals,
  ownerNames,
}: {
  stages: StageRow[]
  deals: KanbanDeal[]
  ownerNames: Record<string, string>
}) {
  const [, startTransition] = useTransition()
  const [dragging, setDragging] = useState<string | null>(null)
  const [hoverStage, setHoverStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [optimisticDeals, applyMove] = useOptimistic(
    deals,
    (current: KanbanDeal[], move: { dealId: string; stageId: string }) =>
      current.map((deal) =>
        deal.id === move.dealId ? { ...deal, stage_id: move.stageId } : deal,
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
      applyMove({ dealId, stageId })
      const result = await moveDealToStage(dealId, stageId)
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
          const total = stageDeals.reduce((sum, deal) => sum + Number(deal.value ?? 0), 0)
          const currency = stageDeals[0]?.currency ?? 'CAD'

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
                  <p className="text-xs text-slate-500">
                    {stageDeals.length} · {formatCurrency(total, currency)}
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
                    className={`cursor-grab rounded-md border border-slate-200 bg-white p-2.5 shadow-sm active:cursor-grabbing ${
                      dragging === deal.id ? 'opacity-50' : ''
                    }`}
                  >
                    <Link
                      href={`/deals/${deal.id}`}
                      className="text-sm font-medium text-slate-900 hover:text-brand-700"
                    >
                      {deal.name}
                    </Link>

                    <p className="mt-1 text-sm font-semibold text-slate-700">
                      {formatCurrency(deal.value, deal.currency)}
                    </p>

                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {deal.companies?.name ??
                        (deal.contacts
                          ? `${deal.contacts.first_name} ${deal.contacts.last_name}`.trim()
                          : '—')}
                    </p>

                    <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                      <span title={deal.probability_overridden ? 'Probability set manually' : 'Stage default'}>
                        {formatPercent(deal.probability)}
                        {deal.probability_overridden && ' ✎'}
                      </span>
                      <span>{formatDate(deal.expected_close_date)}</span>
                    </div>

                    {deal.owner_id && ownerNames[deal.owner_id] && (
                      <p className="mt-1 truncate text-xs text-slate-400">
                        {ownerNames[deal.owner_id]}
                      </p>
                    )}
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
