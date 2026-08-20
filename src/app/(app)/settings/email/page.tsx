import { requireAdmin, scoped } from '@/lib/tenancy'
import { isEmailConfigured, siteUrl } from '@/lib/env'
import type { SendingDomainRow } from '@/lib/database.types'
import { ErrorNote, PageHeader, Section } from '@/components/ui'

import { saveSender, sendTest } from './actions'

export const metadata = { title: 'Email · FLO CRM' }

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>
}) {
  const { error, ok } = await searchParams
  const context = await requireAdmin()

  const { data } = await scoped(context, 'sending_domains').select('*').maybeSingle()
  const sender = data as SendingDomainRow | null
  const configured = isEmailConfigured()

  return (
    <>
      <PageHeader title="Email" />

      {error && <ErrorNote>{error}</ErrorNote>}
      {ok && (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          {ok}
        </p>
      )}

      {!configured && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
          <strong>No API key on this deployment.</strong> Add <code>RESEND_API_KEY</code> in Vercel
          for Production and Preview, then redeploy. Everything below can be filled in first;
          nothing will send until the key is there.
        </p>
      )}

      <div className="space-y-5">
        <Section title="Sender">
          <form action={saveSender} className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="from_name">
                Send as
              </label>
              <input
                id="from_name"
                name="from_name"
                required
                maxLength={120}
                className="input"
                defaultValue={sender?.from_name ?? context.organization.name}
              />
              <p className="mt-1 text-xs text-slate-500">The name a recipient sees.</p>
            </div>

            <div>
              <label className="label" htmlFor="reply_to">
                Replies go to
              </label>
              <input
                id="reply_to"
                name="reply_to"
                type="email"
                className="input"
                placeholder="you@flo-ventures.com"
                defaultValue={sender?.reply_to ?? ''}
              />
              <p className="mt-1 text-xs text-slate-500">
                A mailbox somebody reads. The sending domain does not receive mail.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="from_local">
                From address
              </label>
              <div className="flex items-center gap-1">
                <input
                  id="from_local"
                  name="from_local"
                  required
                  maxLength={64}
                  className="input w-32"
                  defaultValue={sender?.from_local ?? 'hello'}
                />
                <span className="text-sm text-slate-500">@</span>
                <input
                  id="domain"
                  name="domain"
                  required
                  maxLength={255}
                  className="input flex-1"
                  placeholder="news.flo-ventures.com"
                  defaultValue={sender?.domain ?? ''}
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                The verified sending subdomain, not your main domain.
              </p>
            </div>

            {/*
              Required in marketing email by US law, and trivial now versus
              impossible for messages already sent.
            */}
            <div>
              <label className="label" htmlFor="postal_address">
                Postal address
              </label>
              <input
                id="postal_address"
                name="postal_address"
                maxLength={500}
                className="input"
                placeholder="123 King St W, Toronto, ON M5H 1A1"
                defaultValue={sender?.postal_address ?? ''}
              />
              <p className="mt-1 text-xs text-slate-500">
                Printed in the footer of every campaign. Required by anti-spam law.
              </p>
            </div>

            <div className="sm:col-span-2">
              <button type="submit" className="btn-primary">
                Save sender
              </button>
            </div>
          </form>
        </Section>

        <Section title="Send a test">
          {!sender ? (
            <p className="text-sm text-slate-500">Save the sender above first.</p>
          ) : (
            <form action={sendTest} className="space-y-3">
              <p className="text-sm text-slate-600">
                Goes through the same renderer, the same provider and the same headers a campaign
                will, from{' '}
                <strong>
                  {sender.from_name} &lt;{sender.from_local}@{sender.domain}&gt;
                </strong>
                . A rendered preview would prove the template; only a delivered message proves the
                DNS, the key and the domain.
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="to">
                    Send it to
                  </label>
                  <input
                    id="to"
                    name="to"
                    type="email"
                    required
                    className="input"
                    placeholder="you@flo-ventures.com"
                  />
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
                    className="input"
                    defaultValue="Test from the CRM"
                  />
                </div>
              </div>

              <div>
                <label className="label" htmlFor="body">
                  Message
                </label>
                <textarea
                  id="body"
                  name="body"
                  rows={8}
                  required
                  className="input font-normal"
                  defaultValue={
                    'Hello {{first_name}},\n\nThis is a test from the CRM. If you are reading it, the sending domain, the API key and the unsubscribe footer all work.\n\n- **Bold** and *italic*\n- [Links](https://crm.flo-ventures.com)\n- Bullets and 1. numbered lists\n\nThanks.'
                  }
                />
                <p className="mt-1 text-xs text-slate-500">
                  Markdown. Merge fields: <code>{'{{first_name}}'}</code>{' '}
                  <code>{'{{last_name}}'}</code> <code>{'{{company}}'}</code>{' '}
                  <code>{'{{email}}'}</code>
                </p>
              </div>

              <button type="submit" className="btn-primary" disabled={!configured}>
                Send test
              </button>
            </form>
          )}
        </Section>

        <Section title="What to check when it arrives">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-600">
            <li>
              It is in the inbox rather than spam. If it is in spam, look at the headers first —
              <code> dkim=pass</code> and <code>spf=pass</code> should both be there.
            </li>
            <li>
              The <strong>Unsubscribe</strong> link in the footer opens{' '}
              <code>{siteUrl().replace(/^https?:\/\//, '')}/unsubscribe</code> and works without
              logging in.
            </li>
            <li>
              Gmail shows its own <strong>Unsubscribe</strong> button next to the sender name. That
              one comes from the message headers, and it is the button people press instead of
              &ldquo;report spam&rdquo;.
            </li>
            <li>Replying reaches the address set above, not the sending domain.</li>
          </ul>
        </Section>
      </div>
    </>
  )
}
