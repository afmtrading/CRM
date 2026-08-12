import Link from 'next/link'
import { notFound } from 'next/navigation'

import { firstRow, requireSession, scoped } from '@/lib/tenancy'
import {
  CAMPAIGN_STATUS_HINTS,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_TONE,
  isEditable,
  tallyRecipients,
} from '@/lib/campaigns'
import { BLOCKED_REASONS, type BlockedReason } from '@/lib/consent'
import { applyMergeFields, renderEmail, MERGE_FIELDS } from '@/lib/email/render'
import { unsubscribeUrlFor } from '@/lib/email/send'
import type { CampaignRow, EmailListRow, SendingDomainRow } from '@/lib/database.types'
import { ErrorNote, PageHeader, Section } from '@/components/ui'
import { DateTime } from '@/components/date-time'

import {
  buildAudience,
  clearAudience,
  deleteCampaign,
  pauseCampaign,
  resumeCampaign,
  scheduleCampaign,
  sendCampaignTest,
  updateCampaign,
} from '../actions'

export const metadata = { title: 'Campaign · FLO CRM' }

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string; ok?: string }>
}) {
  const { id } = await params
  const { error, ok } = await searchParams
  const context = await requireSession()

  const campaign = await firstRow<CampaignRow>(
    scoped(context, 'campaigns').select('*').eq('id', id).maybeSingle(),
  )
  if (!campaign) notFound()

  const [{ data: lists }, { data: recipients }, senderRow] = await Promise.all([
    scoped(context, 'email_lists').select('*').order('name'),
    scoped(context, 'campaign_recipients')
      .select('status, skip_reason')
      .eq('campaign_id', id),
    firstRow<SendingDomainRow>(scoped(context, 'sending_domains').select('*').maybeSingle()),
  ])

  const listRows = (lists ?? []) as EmailListRow[]
  const recipientRows = (recipients ?? []) as { status: string; skip_reason: string | null }[]
  const tally = tallyRecipients(recipientRows)
  const sender = senderRow

  const skipReasons = new Map<string, number>()
  for (const row of recipientRows) {
    if (row.status !== 'skipped' || !row.skip_reason) continue
    skipReasons.set(row.skip_reason, (skipReasons.get(row.skip_reason) ?? 0) + 1)
  }
  const skipped = [...skipReasons.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({
      reason,
      label: BLOCKED_REASONS[reason as BlockedReason] ?? reason,
      count,
    }))

  const editable = isEditable(campaign.status) && context.canManage
  const list = listRows.find((row) => row.id === campaign.list_id) ?? null

  /*
   * The preview is the real renderer, not an approximation of it. Anything that
   * would go wrong in a delivered message — an image that will not load, a
   * footer that reads oddly — is visible here for the same reason.
   */
  const sampleValues = {
    first_name: 'Alex',
    last_name: 'Doe',
    company: context.organization.name,
    email: 'alex@example.com',
  }

  let previewHtml: string | null = null
  let previewError: string | null = null
  try {
    previewHtml = renderEmail({
      subject: applyMergeFields(campaign.subject, sampleValues),
      body: applyMergeFields(campaign.body, sampleValues),
      organizationName: sender?.from_name ?? context.organization.name,
      logoUrl: context.organization.logo_url,
      postalAddress: sender?.postal_address,
      unsubscribeUrl: unsubscribeUrlFor('00000000-0000-0000-0000-000000000000'),
    }).html
  } catch (renderError) {
    previewError =
      renderError instanceof Error ? renderError.message : 'The message could not be rendered.'
  }

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={campaign.subject}
        actions={
          <>
            <Link href="/campaigns" className="btn-secondary">
              All campaigns
            </Link>
            {context.canManage && ['scheduled', 'sending'].includes(campaign.status) && (
              <form action={pauseCampaign}>
                <input type="hidden" name="id" value={campaign.id} />
                <button type="submit" className="btn-secondary">
                  Pause
                </button>
              </form>
            )}
            {context.canManage && campaign.status === 'paused' && (
              <form action={resumeCampaign}>
                <input type="hidden" name="id" value={campaign.id} />
                <button type="submit" className="btn-primary">
                  Resume
                </button>
              </form>
            )}
            {context.canManage && ['draft', 'failed'].includes(campaign.status) && (
              <form action={deleteCampaign}>
                <input type="hidden" name="id" value={campaign.id} />
                <button type="submit" className="btn-danger">
                  Delete
                </button>
              </form>
            )}
          </>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {ok && (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          {ok}
        </p>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <span
          className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${CAMPAIGN_STATUS_TONE[campaign.status]}`}
        >
          {CAMPAIGN_STATUS_LABELS[campaign.status]}
        </span>
        <span className="text-sm text-slate-600">{CAMPAIGN_STATUS_HINTS[campaign.status]}</span>
        {campaign.scheduled_at && (
          <span className="ml-auto text-sm text-slate-500">
            {campaign.status === 'sent' ? 'Finished' : 'Due'}{' '}
            <DateTime value={campaign.finished_at ?? campaign.scheduled_at} />
          </span>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3 lg:items-start">
        <div className="grid gap-5 lg:col-span-2">
          <Section title={editable ? 'The message' : 'The message, as sent'}>
            {editable ? (
              <form action={updateCampaign} className="grid gap-3">
                <input type="hidden" name="id" value={campaign.id} />

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="name">
                      Name
                    </label>
                    <input
                      id="name"
                      name="name"
                      required
                      maxLength={160}
                      defaultValue={campaign.name}
                      className="input"
                    />
                  </div>

                  <div>
                    <label className="label" htmlFor="list_id">
                      Send to
                    </label>
                    <select
                      id="list_id"
                      name="list_id"
                      className="input"
                      defaultValue={campaign.list_id ?? ''}
                    >
                      <option value="">Choose a list</option>
                      {listRows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="label" htmlFor="subject">
                    Subject
                  </label>
                  <input
                    id="subject"
                    name="subject"
                    required
                    maxLength={200}
                    defaultValue={campaign.subject}
                    className="input"
                  />
                </div>

                <div>
                  <label className="label" htmlFor="body">
                    Message
                  </label>
                  <textarea
                    id="body"
                    name="body"
                    required
                    rows={16}
                    defaultValue={campaign.body}
                    className="input font-mono text-[13px]"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Markdown: <code># heading</code>, <code>**bold**</code>, <code>- bullets</code>,{' '}
                    <code>[link](https://…)</code>, <code>![alt](https://…image.png)</code>. Merge
                    fields:{' '}
                    {MERGE_FIELDS.map((field) => (
                      <code key={field} className="mr-1">{`{{${field}}}`}</code>
                    ))}
                    — an unknown one is left visible rather than blanked, so a typo shows.
                  </p>
                </div>

                <div>
                  <button type="submit" className="btn-primary">
                    Save draft
                  </button>
                </div>
              </form>
            ) : (
              <div className="grid gap-2 text-sm">
                <div>
                  <span className="text-slate-500">Subject</span>
                  <p className="font-medium text-slate-900">{campaign.subject}</p>
                </div>
                <div>
                  <span className="text-slate-500">Message</span>
                  <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-[13px] text-slate-700">
                    {campaign.body}
                  </pre>
                </div>
              </div>
            )}
          </Section>

          <Section title="Preview">
            {previewError ? (
              <ErrorNote>{previewError}</ErrorNote>
            ) : (
              <>
                <p className="mb-3 text-sm text-slate-600">
                  Rendered by the same code that builds the real message, with sample merge values.
                </p>
                {/*
                  srcDoc rather than injecting the HTML into this page: an email
                  is a whole document with its own styles, and it must not be
                  able to reach the CRM's. The sandbox leaves it inert.
                */}
                <iframe
                  title="Email preview"
                  srcDoc={previewHtml ?? ''}
                  sandbox=""
                  className="h-[520px] w-full rounded-lg border border-slate-200 bg-white"
                />
              </>
            )}
          </Section>
        </div>

        <div className="grid gap-5">
          <Section title="Audience">
            {!list ? (
              <p className="text-sm text-slate-600">
                No list chosen yet. Pick one above, or{' '}
                <Link href="/lists" className="text-brand-700 hover:underline">
                  make a list
                </Link>{' '}
                first.
              </p>
            ) : (
              <div className="grid gap-3 text-sm">
                <p className="text-slate-600">
                  From{' '}
                  <Link href={`/lists/${list.id}`} className="text-brand-700 hover:underline">
                    {list.name}
                  </Link>
                  {list.saved_filter_id && ' — a filter, re-read when the audience is built'}.
                </p>

                {tally.total === 0 ? (
                  <p className="text-slate-600">
                    Nobody is queued yet. Building the audience works out who this would reach, and
                    who it would not, before anything is sent.
                  </p>
                ) : (
                  <dl className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-emerald-50 px-3 py-2">
                      <dt className="text-xs text-emerald-700">Will receive it</dt>
                      <dd className="text-lg font-semibold tabular-nums text-emerald-800">
                        {campaign.status === 'draft' || campaign.status === 'scheduled'
                          ? tally.pending
                          : tally.sent}
                      </dd>
                    </div>
                    <div className="rounded-lg bg-slate-100 px-3 py-2">
                      <dt className="text-xs text-slate-600">Withheld</dt>
                      <dd className="text-lg font-semibold tabular-nums text-slate-700">
                        {tally.skipped}
                      </dd>
                    </div>
                  </dl>
                )}

                {/*
                  The withheld are itemised rather than totalled. "Forty people
                  are not getting this" is a number somebody should be able to
                  act on, and they cannot act on it without the reason.
                */}
                {skipped.length > 0 && (
                  <ul className="grid gap-1 text-xs text-slate-600">
                    {skipped.map((row) => (
                      <li key={row.reason} className="flex justify-between gap-2">
                        <span>{row.label}</span>
                        <span className="tabular-nums">{row.count}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {context.canManage && ['draft', 'scheduled'].includes(campaign.status) && (
                  <div className="flex flex-wrap gap-2">
                    <form action={buildAudience}>
                      <input type="hidden" name="id" value={campaign.id} />
                      <button type="submit" className="btn-secondary">
                        {tally.total === 0 ? 'Build audience' : 'Refresh audience'}
                      </button>
                    </form>
                    {tally.total > 0 && (
                      <form action={clearAudience}>
                        <input type="hidden" name="id" value={campaign.id} />
                        <button type="submit" className="btn-secondary">
                          Clear
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            )}
          </Section>

          {context.canManage && campaign.status === 'draft' && (
            <Section title="Send a test">
              <form action={sendCampaignTest} className="grid gap-2">
                <input type="hidden" name="id" value={campaign.id} />
                <label className="label" htmlFor="to">
                  To
                </label>
                <input
                  id="to"
                  name="to"
                  type="email"
                  required
                  className="input"
                  placeholder="you@example.com"
                  defaultValue={context.user.email ?? ''}
                />
                <p className="text-xs text-slate-500">
                  A real message through the real provider — the only way to see how it actually
                  arrives.
                </p>
                <button type="submit" className="btn-secondary">
                  Send test
                </button>
              </form>
            </Section>
          )}

          {context.canManage && campaign.status === 'draft' && (
            <Section title="Send it">
              <form action={scheduleCampaign} className="grid gap-2">
                <input type="hidden" name="id" value={campaign.id} />
                <label className="label" htmlFor="when">
                  When
                </label>
                <input id="when" name="when" type="datetime-local" className="input" />
                <p className="text-xs text-slate-500">
                  Leave it empty to start now. Either way it goes out in batches over the following
                  minutes rather than all at once.
                </p>
                <button type="submit" className="btn-primary" disabled={tally.pending === 0}>
                  {tally.pending === 0
                    ? 'Build the audience first'
                    : `Schedule for ${tally.pending} ${tally.pending === 1 ? 'person' : 'people'}`}
                </button>
              </form>
            </Section>
          )}

          {tally.sent > 0 && (
            <Section title="What happened">
              <dl className="grid gap-1.5 text-sm">
                {[
                  ['Sent', tally.sent],
                  ['Delivered', tally.delivered],
                  ['Opened', tally.opened],
                  ['Clicked', tally.clicked],
                  ['Bounced', tally.bounced],
                  ['Marked as spam', tally.complained],
                  ['Failed', tally.failed],
                ]
                  .filter(([, count]) => (count as number) > 0)
                  .map(([label, count]) => (
                    <div key={label as string} className="flex justify-between gap-2">
                      <dt className="text-slate-600">{label}</dt>
                      <dd className="tabular-nums font-medium text-slate-900">{count}</dd>
                    </div>
                  ))}
              </dl>
              {tally.opened === 0 && tally.delivered > 0 && (
                <p className="mt-3 text-xs text-slate-500">
                  Opens and clicks are not being tracked on the sending domain, so those stay at
                  zero however many people read it.
                </p>
              )}
            </Section>
          )}
        </div>
      </div>
    </>
  )
}
