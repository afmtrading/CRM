import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import { contactName, formatCurrency, formatDate } from '@/lib/format'
import type { ActivityRow, CompanyRow, ContactRow, DealRow, UserRow } from '@/lib/database.types'
import { ActivityComposer, ActivityTimeline } from '@/components/activity-timeline'
import { DealStatusBadge, LifecycleBadge, PageHeader, Section } from '@/components/ui'

import { deleteCompany } from '../actions'

export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const company = await firstRow<CompanyRow>(
    scoped(context, 'companies').select('*').eq('id', id).maybeSingle(),
  )

  if (!company) notFound()

  const [{ data: contacts }, { data: deals }, { data: activities }, { data: users }] = await Promise.all([
    scoped(context, 'contacts')
      .select('*')
      .eq('company_id', id)
      .is('duplicate_of_id', null)
      .order('last_name'),
    scoped(context, 'deals').select('*, stages(name)').eq('company_id', id).order('created_at', { ascending: false }),
    scoped(context, 'activities')
      .select('*')
      .eq('related_to_type', 'company')
      .eq('related_to_id', id)
      .order('occurred_at', { ascending: false })
      .limit(100),
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
  ])

  const userList = (users ?? []) as UserRow[]
  const owner = userList.find((user) => user.id === company.owner_id)
  const customFields = Object.entries((company.custom_fields ?? {}) as Record<string, unknown>)
  const dealRows = (deals ?? []) as (DealRow & { stages: { name: string } | null })[]

  return (
    <>
      <PageHeader
        title={company.name}
        description={company.domain ?? undefined}
        actions={
          <>
            <Link href={`/companies/${id}/edit`} className="btn-secondary">
              Edit
            </Link>
            <form action={deleteCompany}>
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
            title="Contacts"
            actions={
              <Link href="/contacts/new" className="btn-secondary py-1">
                New contact
              </Link>
            }
          >
            {(contacts ?? []).length === 0 ? (
              <p className="text-sm text-slate-500">No contacts at this company yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Stage</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {((contacts ?? []) as ContactRow[]).map((contact) => (
                    <tr key={contact.id}>
                      <td>
                        <Link href={`/contacts/${contact.id}`} className="font-medium text-brand-700 hover:underline">
                          {contactName(contact)}
                        </Link>
                      </td>
                      <td className="text-slate-600">{contact.email ?? '—'}</td>
                      <td>
                        <LifecycleBadge stage={contact.lifecycle_stage} />
                      </td>
                      <td>{contact.lead_score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Deals">
            {dealRows.length === 0 ? (
              <p className="text-sm text-slate-500">No deals linked to this company.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Deal</th>
                    <th>Stage</th>
                    <th>Value</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {dealRows.map((deal) => (
                    <tr key={deal.id}>
                      <td>
                        <Link href={`/deals/${deal.id}`} className="font-medium text-brand-700 hover:underline">
                          {deal.name}
                        </Link>
                      </td>
                      <td>{deal.stages?.name ?? '—'}</td>
                      <td>{formatCurrency(deal.value, deal.currency)}</td>
                      <td>
                        <DealStatusBadge status={deal.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Activity">
            <ActivityComposer
              relatedToType="company"
              relatedToId={id}
              users={userList}
              currentUserId={context.user.id}
            />
            <div className="mt-4 border-t border-slate-100 pt-2">
              <ActivityTimeline
                activities={(activities ?? []) as ActivityRow[]}
                users={userList}
                returnTo={`/companies/${id}`}
              />
            </div>
          </Section>
        </div>

        <Section title="Details">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Industry</dt>
              <dd className="mt-0.5 text-slate-800">{company.industry ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Owner</dt>
              <dd className="mt-0.5 text-slate-800">{owner ? owner.name || owner.email : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Created</dt>
              <dd className="mt-0.5 text-slate-800">{formatDate(company.created_at)}</dd>
            </div>
            {customFields.map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs text-slate-500">{key}</dt>
                <dd className="mt-0.5 text-slate-800">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </Section>
      </div>
    </>
  )
}
