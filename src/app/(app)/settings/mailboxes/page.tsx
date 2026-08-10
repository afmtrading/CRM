import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { formatNumber } from '@/lib/format'
import { DateTime } from '@/components/date-time'
import { isGoogleConfigured } from '@/lib/env'
import { isTokenKeyConfigured } from '@/lib/crypto'
import type { MailboxConnectionRow, UserRow } from '@/lib/database.types'
import { EmptyState, ErrorNote, PageHeader, Section } from '@/components/ui'
import { AlertIcon, MailIcon, PlusIcon } from '@/components/icons'

import { disconnectMailbox, setMailboxBackfill } from './actions'

export const metadata = { title: 'Mailboxes · FLO CRM' }

/**
 * Never `select('*')` here. The refresh token column carries no grant for
 * `authenticated`, so a star select is refused by the database — deliberately,
 * so this cannot be loosened by accident.
 */
const COLUMNS =
  'id, organization_id, user_id, provider, email_address, history_id, backfill_days, backfill_until, calendar_state, status, last_error, last_synced_at, messages_logged, created_at, updated_at'

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700',
  needs_reauth: 'bg-amber-100 text-amber-800',
  disabled: 'bg-slate-100 text-slate-600',
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Syncing',
  needs_reauth: 'Needs reconnecting',
  disabled: 'Disconnected',
}

const ERRORS: Record<string, string> = {
  'not-configured':
    'Gmail sync is not configured yet. An administrator needs to set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and MAILBOX_TOKEN_KEY.',
  permission: 'Your role does not allow connecting a mailbox.',
  denied: 'Google access was declined, so nothing was connected.',
  state: 'That link expired or did not come from here. Start again from this page.',
  exchange: 'Google refused the authorisation. Check the redirect URI in the Google Cloud console.',
  'no-refresh-token':
    'Google did not return a refresh token. Remove the app under your Google account permissions and connect again.',
  profile: 'Connected, but the mailbox address could not be read. Try again.',
  save: 'The connection could not be saved. Try again.',
}

/**
 * How far the history import has got.
 *
 * New mail arrives through a separate cursor and is never waiting on this, so
 * the sensible thing to show is progress rather than a warning: a mailbox part
 * way through its archive is working normally, not stuck.
 */
function historyProgress(connection: MailboxConnectionRow) {
  const windowStart = Date.now() - connection.backfill_days * 86_400_000
  const until = connection.backfill_until ? Date.parse(connection.backfill_until) : null

  if (until !== null && until <= windowStart) return <>{connection.backfill_days} days imported</>
  if (until === null) return <>history import queued</>

  return (
    <>
      importing history · back to <DateTime value={connection.backfill_until} dateOnly />
    </>
  )
}

export default async function MailboxesPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>
}) {
  const params = await searchParams
  const context = await requireSession()

  const [{ data }, { data: users }] = await Promise.all([
    scoped(context, 'mailbox_connections').select(COLUMNS).order('created_at'),
    scoped(context, 'users').select('*'),
  ])

  const connections = (data ?? []) as MailboxConnectionRow[]
  const userList = (users ?? []) as UserRow[]
  const configured = isGoogleConfigured() && isTokenKeyConfigured()

  const mine = connections.filter((connection) => connection.user_id === context.user.id)
  const others = connections.filter((connection) => connection.user_id !== context.user.id)

  const ownerName = (userId: string) => {
    const user = userList.find((candidate) => candidate.id === userId)
    return user ? user.name || user.email : 'Unknown user'
  }

  const card = (connection: MailboxConnectionRow, showOwner: boolean) => (
    <li key={connection.id} className="flex flex-wrap items-start gap-3 py-4 first:pt-0">
      <span
        className={`icon-chip mt-0.5 h-10 w-10 ${
          connection.status === 'needs_reauth'
            ? 'bg-amber-100 text-amber-700'
            : 'bg-brand-50 text-brand-700'
        }`}
      >
        {connection.status === 'needs_reauth' ? (
          <AlertIcon className="h-5 w-5" />
        ) : (
          <MailIcon className="h-5 w-5" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
          {connection.email_address}
          <span className={`badge ${STATUS_STYLES[connection.status] ?? STATUS_STYLES.disabled}`}>
            {STATUS_LABELS[connection.status] ?? connection.status}
          </span>
        </p>

        <p className="mt-1 text-xs text-slate-500">
          {showOwner && <>{ownerName(connection.user_id)} · </>}
          {connection.last_synced_at ? (
            <>
              Last synced <DateTime value={connection.last_synced_at} />
            </>
          ) : (
            'Not synced yet'
          )}
          <span className="mx-1.5 text-slate-300">·</span>
          {formatNumber(connection.messages_logged)} logged
          <span className="mx-1.5 text-slate-300">·</span>
          {historyProgress(connection)}
        </p>

        {connection.status === 'active' && connection.calendar_state === 'unauthorised' && (
          <p className="mt-1.5 text-xs text-slate-500">
            Calendar not included — this mailbox was connected before meetings were synced.
            Reconnect to add them. Email keeps working either way.
          </p>
        )}

        {connection.last_error && (
          <p className="mt-1.5 text-xs text-amber-700">{connection.last_error}</p>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {context.isAdmin && connection.status !== 'disabled' && (
          <form action={setMailboxBackfill} className="flex items-center gap-1.5">
            <input type="hidden" name="id" value={connection.id} />
            <label className="sr-only" htmlFor={`backfill-${connection.id}`}>
              Backfill window for {connection.email_address}
            </label>
            <select
              id={`backfill-${connection.id}`}
              name="backfill_days"
              className="input py-1 text-xs"
              defaultValue={connection.backfill_days}
            >
              {[7, 30, 90, 180, 365].map((days) => (
                <option key={days} value={days}>
                  {days} days
                </option>
              ))}
            </select>
            <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
              Set
            </button>
          </form>
        )}

        {/*
          A mailbox that needs reconnecting gets the prominent button, because
          that is the whole of what is being asked of the person looking at it.
          It keeps Disconnect too — needing to reauthorise is a reasonable
          moment to decide you would rather not.
        */}
        {connection.status !== 'active' && (
          <Link
            href="/api/gmail/connect"
            className={`px-2.5 py-1 text-xs ${
              connection.status === 'needs_reauth' ? 'btn-primary' : 'btn-secondary'
            }`}
          >
            Reconnect
          </Link>
        )}

        {connection.status !== 'disabled' && (
          <form action={disconnectMailbox}>
            <input type="hidden" name="id" value={connection.id} />
            <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
              Disconnect
            </button>
          </form>
        )}
      </div>
    </li>
  )

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Connect Gmail and emails with people already in the CRM appear on their timeline automatically. Nothing is sent from here — you keep writing in Gmail."
        actions={
          configured && context.canWrite ? (
            <Link href="/api/gmail/connect" className="btn-primary">
              <PlusIcon className="h-4 w-4" />
              Connect Gmail
            </Link>
          ) : undefined
        }
      />

      {params.error && (
        <div className="mb-5">
          <ErrorNote>{ERRORS[params.error] ?? params.error}</ErrorNote>
        </div>
      )}

      {params.connected && (
        <p className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          {params.connected} is connected. New mail is picked up from the next scheduled poll;
          the history window below imports over the runs after that.
        </p>
      )}

      {!configured && (
        <div className="mb-5">
          <ErrorNote>{ERRORS['not-configured']}</ErrorNote>
        </div>
      )}

      <div className="space-y-5">
        <Section title="Your mailboxes">
          {mine.length === 0 ? (
            <EmptyState
              title="No mailbox connected"
              description="Connect the Gmail account you email clients from. Only messages involving a contact already in the CRM are stored — everything else is discarded, not saved."
              action={
                configured && context.canWrite ? (
                  <Link href="/api/gmail/connect" className="btn-primary">
                    Connect Gmail
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {mine.map((connection) => card(connection, false))}
            </ul>
          )}
        </Section>

        {context.isAdmin && others.length > 0 && (
          <Section title="Everyone else">
            <ul className="divide-y divide-slate-100">
              {others.map((connection) => card(connection, true))}
            </ul>
          </Section>
        )}

        <Section title="What gets stored">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-600">
            <li>
              Only emails and meetings involving someone already in the CRM. Anything matching no
              contact is discarded on arrival — personal mail and private appointments never reach
              the database.
            </li>
            <li>
              Read-only access. The connection cannot send, delete or relabel anything in your
              mailbox.
            </li>
            <li>
              Quoted reply chains are stripped, so a timeline entry is what the person wrote rather
              than the whole conversation again.
            </li>
            <li>
              A logged email obeys the same visibility rules as the contact it is attached to — it
              does not become visible to anyone who could not already see that record.
            </li>
            <li>You can disconnect at any time, which destroys the stored credentials.</li>
            <li>
              Google ends an authorisation now and then — a revoked grant, a changed password, or
              the seven-day limit that applies while this app is in Google&apos;s testing mode. The
              mailbox then reads <em>Needs reconnecting</em> and one click restores it. Nothing
              already on a timeline is lost, and syncing resumes where it stopped.
            </li>
          </ul>
        </Section>
      </div>
    </>
  )
}
