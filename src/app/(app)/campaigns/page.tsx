import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import {
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_TONE,
  tallyRecipients,
} from '@/lib/campaigns'
import { isEmailConfigured } from '@/lib/env'
import type { CampaignRow, EmailListRow, SendingDomainRow } from '@/lib/database.types'
import { EmptyState, ErrorNote, PageHeader, Section } from '@/components/ui'
import { DateTime } from '@/components/date-time'

import { createCampaign } from './actions'
import { CampaignMessageEditor } from './message-editor'

export const metadata = { title: 'Campaigns · FLO CRM' }

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>
}) {
  const { error, ok } = await searchParams
  const context = await requireSession()

  const [{ data: campaigns }, { data: lists }, { data: recipients }, { data: senderRow }] =
    await Promise.all([
      scoped(context, 'campaigns').select('*').order('created_at', { ascending: false }),
      scoped(context, 'email_lists').select('*').order('name'),
      scoped(context, 'campaign_recipients').select('campaign_id, status'),
      scoped(context, 'sending_domains').select('*').maybeSingle(),
    ])

  const campaignRows = (campaigns ?? []) as CampaignRow[]
  const listRows = (lists ?? []) as EmailListRow[]
  const sender = senderRow as SendingDomainRow | null

  const byCampaign = new Map<string, { status: string }[]>()
  for (const row of (recipients ?? []) as { campaign_id: string; status: string }[]) {
    const existing = byCampaign.get(row.campaign_id)
    if (existing) existing.push(row)
    else byCampaign.set(row.campaign_id, [row])
  }

  const listName = (id: string | null) =>
    id ? (listRows.find((list) => list.id === id)?.name ?? '—') : '—'

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="An email to a list. Nothing is sent until you schedule it, and nothing is sent to somebody who has not agreed to hear from you."
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {ok && (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          {ok}
        </p>
      )}

      {/*
        Said here rather than at the moment somebody presses Schedule, which is
        the worst time to find out. Both are one-time setup by an administrator.
      */}
      {context.canManage && (!sender || !isEmailConfigured()) && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
          {!isEmailConfigured()
            ? 'Email sending is not configured on this deployment yet, so nothing can go out.'
            : (
              <>
                No sender is set up yet — there is no From address to send as. Set one under{' '}
                <Link href="/settings/email" className="underline">
                  Settings → Email sending
                </Link>
                .
              </>
            )}
        </div>
      )}

      {context.canManage && (
        <Section title="New campaign">
          {listRows.length === 0 ? (
            <p className="text-sm text-slate-600">
              There are no lists yet. A campaign goes to a list, so{' '}
              <Link href="/lists" className="text-brand-700 hover:underline">
                make one first
              </Link>
              .
            </p>
          ) : (
            <form action={createCampaign} className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="name">
                  Name
                </label>
                <input id="name" name="name" required maxLength={160} className="input" />
                <p className="mt-1 text-xs text-slate-500">
                  For you, not the recipients. They never see it.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="list_id">
                  Send to
                </label>
                <select id="list_id" name="list_id" className="input" defaultValue="">
                  <option value="">Decide later</option>
                  {listRows.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="label" htmlFor="subject">
                  Subject
                </label>
                <input id="subject" name="subject" required maxLength={200} className="input" />
              </div>

              <div className="sm:col-span-2">
                <label className="label" htmlFor="body">
                  Message
                </label>
                <CampaignMessageEditor rows={8} />
                <p className="mt-1 text-xs text-slate-500">
                  Format it with the buttons, drop in a merge field, and press Preview to see what
                  arrives. You can refine it on the next screen.
                </p>
              </div>

              <div className="sm:col-span-2">
                <button type="submit" className="btn-primary">
                  Create draft
                </button>
              </div>
            </form>
          )}
        </Section>
      )}

      <div className="mt-5">
        <Section title="All campaigns">
          {campaignRows.length === 0 ? (
            <EmptyState
              title="No campaigns yet"
              description="A campaign is one message to one list. Drafts are safe — nothing leaves until you schedule it."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">List</th>
                    <th className="py-2 pr-4 text-right font-medium">Sent</th>
                    <th className="py-2 pr-4 text-right font-medium">Withheld</th>
                    <th className="py-2 pr-4 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignRows.map((campaign) => {
                    const tally = tallyRecipients(byCampaign.get(campaign.id) ?? [])
                    return (
                      <tr key={campaign.id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2.5 pr-4">
                          <Link
                            href={`/campaigns/${campaign.id}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {campaign.name}
                          </Link>
                          <div className="text-xs text-slate-500">{campaign.subject}</div>
                        </td>
                        <td className="py-2.5 pr-4">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${CAMPAIGN_STATUS_TONE[campaign.status]}`}
                          >
                            {CAMPAIGN_STATUS_LABELS[campaign.status]}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 text-slate-600">{listName(campaign.list_id)}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-slate-700">
                          {tally.sent || '—'}
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-slate-500">
                          {tally.skipped || '—'}
                        </td>
                        <td className="py-2.5 pr-4 text-slate-500">
                          {campaign.scheduled_at ? (
                            <DateTime value={campaign.scheduled_at} />
                          ) : (
                            <DateTime value={campaign.created_at} />
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </>
  )
}
