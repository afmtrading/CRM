import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import { contactName, formatCurrency, formatDay, formatNumber, formatPercent } from '@/lib/format'
import type {
  ActivityRow,
  DealProductRow,
  DealRow,
  ProductRow,
  StageRow,
  UserRow,
} from '@/lib/database.types'
import { ActivityComposer, ActivityTimeline } from '@/components/activity-timeline'
import { DealStatusBadge, PageHeader, Section } from '@/components/ui'
import { TrashIcon } from '@/components/icons'

import {
  addDealProduct,
  deleteDeal,
  removeDealProduct,
  resetDealProbability,
  updateDealProduct,
  useLineItemsForValue,
} from '../actions'
import { AddLineItem } from '../line-items'

type DealWithRelations = DealRow & {
  stages: (StageRow & { pipelines: { id: string; name: string } | null }) | null
  contacts: { id: string; first_name: string; last_name: string; email: string | null } | null
  companies: { id: string; name: string } | null
}

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const deal = await firstRow<DealWithRelations>(
    scoped(context, 'deals')
      .select(
        '*, stages(*, pipelines(id, name)), contacts(id, first_name, last_name, email), companies(id, name)',
      )
      .eq('id', id)
      .maybeSingle(),
  )

  if (!deal) notFound()

  const [{ data: activities }, { data: users }, { data: lines }, { data: catalogue }] =
    await Promise.all([
      scoped(context, 'activities')
        .select('*')
        .eq('related_to_type', 'deal')
        .eq('related_to_id', id)
        .order('occurred_at', { ascending: false })
        .limit(100),
      scoped(context, 'users').select('*').eq('status', 'active').order('name'),
      scoped(context, 'deal_products')
        .select('*, products(id, name, sku, unit)')
        .eq('deal_id', id)
        .order('position'),
      scoped(context, 'products')
        .select('*')
        .is('deleted_at', null)
        .eq('active', true)
        .order('name'),
    ])

  const userList = (users ?? []) as UserRow[]
  const owner = userList.find((user) => user.id === deal.owner_id)

  const lineItems = (lines ?? []) as (DealProductRow & {
    products: { id: string; name: string; sku: string | null; unit: string } | null
  })[]
  const products = (catalogue ?? []) as ProductRow[]

  const lineTotal = lineItems.reduce((sum, line) => sum + Number(line.line_total), 0)
  const lineCost = lineItems.reduce((sum, line) => sum + Number(line.line_cost), 0)
  // The deal follows its line items unless someone typed a value. When the two
  // disagree, say so rather than quietly showing one of them.
  const followsProducts = deal.value_source === 'products'
  const valueDiffers =
    !followsProducts && lineItems.length > 0 && Math.abs(lineTotal - Number(deal.value)) > 0.005

  return (
    <>
      <PageHeader
        title={deal.name}
        description={`${formatCurrency(deal.value, deal.currency)} · ${deal.stages?.name ?? 'No stage'}`}
        actions={
          <>
            <Link href={`/deals/${id}/edit`} className="btn-secondary">
              Edit
            </Link>
            <form action={deleteDeal}>
              <input type="hidden" name="id" value={id} />
              <button type="submit" className="btn-danger">
                Delete
              </button>
            </form>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Section
            title="Line items"
            actions={
              <span className="text-xs text-slate-500">
                {followsProducts
                  ? 'The deal value follows these lines'
                  : 'The deal value was entered by hand'}
              </span>
            }
          >
            {lineItems.length === 0 ? (
              <p className="mb-4 text-sm text-slate-500">
                Nothing listed yet. Adding a product sets the deal&rsquo;s value from its lines
                &mdash; unless a value has already been typed, which stays as it is.
              </p>
            ) : (
              <ul className="mb-4 divide-y divide-slate-100">
                {lineItems.map((line) => (
                  <li key={line.id} className="py-3 first:pt-0">
                    <form
                      action={updateDealProduct}
                      className="flex flex-wrap items-end gap-3 sm:flex-nowrap"
                    >
                      <input type="hidden" name="id" value={line.id} />
                      <input type="hidden" name="deal_id" value={id} />

                      <div className="min-w-40 flex-1">
                        {line.products ? (
                          <Link
                            href={`/products/${line.products.id}`}
                            className="text-sm font-medium text-slate-900 hover:text-brand-700"
                          >
                            {line.products.name}
                          </Link>
                        ) : (
                          <span className="text-sm text-slate-500">Unknown product</span>
                        )}
                        <p className="text-xs text-slate-400">
                          {[line.products?.sku, line.products?.unit && `per ${line.products.unit}`]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </p>
                      </div>

                      <div className="w-24">
                        <label className="label" htmlFor={`qty-${line.id}`}>
                          Qty
                        </label>
                        <input
                          id={`qty-${line.id}`}
                          name="quantity"
                          type="number"
                          step="0.001"
                          min="0"
                          className="input"
                          defaultValue={line.quantity}
                          readOnly={!context.canWrite}
                        />
                      </div>

                      <div className="w-28">
                        <label className="label" htmlFor={`price-${line.id}`}>
                          Price
                        </label>
                        <input
                          id={`price-${line.id}`}
                          name="unit_price"
                          type="number"
                          step="0.01"
                          min="0"
                          className="input"
                          defaultValue={line.unit_price}
                          readOnly={!context.canWrite}
                        />
                      </div>

                      <div className="w-20">
                        <label className="label" htmlFor={`disc-${line.id}`}>
                          Disc %
                        </label>
                        <input
                          id={`disc-${line.id}`}
                          name="discount_pct"
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          className="input"
                          defaultValue={line.discount_pct}
                          readOnly={!context.canWrite}
                        />
                      </div>

                      <div className="w-28 pb-2 text-right">
                        <p className="text-sm font-semibold text-slate-900">
                          {formatCurrency(Number(line.line_total), deal.currency)}
                        </p>
                        <p className="text-xs text-slate-400">
                          cost {formatCurrency(Number(line.line_cost), deal.currency)}
                        </p>
                      </div>

                      {context.canWrite && (
                        <div className="flex items-center gap-1 pb-1.5">
                          <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
                            Save
                          </button>
                          {/* Same form, different action — the row carries the
                              id and deal_id both of them need. */}
                          <button
                            type="submit"
                            formAction={removeDealProduct}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                            aria-label={`Remove ${line.products?.name ?? 'line item'}`}
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </form>
                  </li>
                ))}
              </ul>
            )}

            {lineItems.length > 0 && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3">
                <div className="text-sm text-slate-600">
                  <span className="font-semibold text-slate-900">
                    {formatCurrency(lineTotal, deal.currency)}
                  </span>{' '}
                  across {formatNumber(lineItems.length)} line
                  {lineItems.length === 1 ? '' : 's'}
                  <span className="mx-2 text-slate-300">·</span>
                  margin {formatCurrency(lineTotal - lineCost, deal.currency)}
                </div>

                {valueDiffers && (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-amber-800">
                    <span>
                      The deal is priced at {formatCurrency(Number(deal.value), deal.currency)}.
                    </span>
                    {context.canWrite && (
                      <form action={useLineItemsForValue}>
                        <input type="hidden" name="deal_id" value={id} />
                        <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
                          Use the line items
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            )}

            {context.canWrite && (
              <div className="border-t border-slate-100 pt-4">
                <AddLineItem
                  dealId={id}
                  dealCurrency={deal.currency}
                  products={products}
                  action={addDealProduct}
                />
              </div>
            )}
          </Section>

          <Section title="Activity">
            <ActivityComposer
              relatedToType="deal"
              relatedToId={id}
              users={userList}
              currentUserId={context.user.id}
            />
            <div className="mt-4 border-t border-slate-100 pt-2">
              <ActivityTimeline
                activities={(activities ?? []) as ActivityRow[]}
                users={userList}
                returnTo={`/deals/${id}`}
              />
            </div>
          </Section>
        </div>

        <Section title="Details">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Status</dt>
              <dd className="mt-0.5">
                <DealStatusBadge status={deal.status} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Pipeline / stage</dt>
              <dd className="mt-0.5 text-slate-800">
                {deal.stages?.pipelines?.name ?? '—'} · {deal.stages?.name ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Probability</dt>
              <dd className="mt-0.5 flex items-center gap-2 text-slate-800">
                {formatPercent(deal.probability)}
                {deal.probability_overridden ? (
                  <>
                    <span className="badge bg-amber-100 text-amber-800">manual</span>
                    <form action={resetDealProbability}>
                      <input type="hidden" name="id" value={id} />
                      <button type="submit" className="text-xs text-brand-700 hover:underline">
                        Follow stage default
                      </button>
                    </form>
                  </>
                ) : (
                  <span className="badge bg-slate-100 text-slate-600">stage default</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Value</dt>
              <dd className="mt-0.5 flex flex-wrap items-center gap-2 text-slate-800">
                {formatCurrency(deal.value, deal.currency)}
                {followsProducts ? (
                  <span className="badge bg-slate-100 text-slate-600">from line items</span>
                ) : (
                  <span className="badge bg-amber-100 text-amber-800">entered by hand</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Weighted value</dt>
              <dd className="mt-0.5 text-slate-800">
                {formatCurrency(deal.value * deal.probability, deal.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Contact</dt>
              <dd className="mt-0.5">
                {deal.contacts ? (
                  <Link href={`/contacts/${deal.contacts.id}`} className="text-brand-700 hover:underline">
                    {contactName(deal.contacts)}
                  </Link>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Company</dt>
              <dd className="mt-0.5">
                {deal.companies ? (
                  <Link href={`/companies/${deal.companies.id}`} className="text-brand-700 hover:underline">
                    {deal.companies.name}
                  </Link>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Owner</dt>
              <dd className="mt-0.5 text-slate-800">{owner ? owner.name || owner.email : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Expected close</dt>
              <dd className="mt-0.5 text-slate-800">{formatDay(deal.expected_close_date)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Actual close</dt>
              <dd className="mt-0.5 text-slate-800">{formatDay(deal.actual_close_date)}</dd>
            </div>
          </dl>
        </Section>
      </div>
    </>
  )
}
