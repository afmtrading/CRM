import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import { contactName, formatCurrency, formatDate, formatPercent } from '@/lib/format'
import type { ActivityRow, DealRow, StageRow, UserRow } from '@/lib/database.types'
import { ActivityComposer, ActivityTimeline } from '@/components/activity-timeline'
import { DealStatusBadge, PageHeader, Section } from '@/components/ui'

import { deleteDeal, resetDealProbability } from '../actions'

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

  const [{ data: activities }, { data: users }] = await Promise.all([
    scoped(context, 'activities')
      .select('*')
      .eq('related_to_type', 'deal')
      .eq('related_to_id', id)
      .order('occurred_at', { ascending: false })
      .limit(100),
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
  ])

  const userList = (users ?? []) as UserRow[]
  const owner = userList.find((user) => user.id === deal.owner_id)

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
              <dd className="mt-0.5 text-slate-800">{formatDate(deal.expected_close_date)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Actual close</dt>
              <dd className="mt-0.5 text-slate-800">{formatDate(deal.actual_close_date)}</dd>
            </div>
          </dl>
        </Section>
      </div>
    </>
  )
}
