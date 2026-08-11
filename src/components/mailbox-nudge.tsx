'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { MailIcon, AlertIcon } from '@/components/icons'

/**
 * A nudge towards connecting a mailbox, for people who have no reason to know
 * they should.
 *
 * The Mailboxes page lives in the account menu for everyone but the sidebar
 * only for administrators, so a rep signs in, sees a CRM, and never discovers
 * that their email could be logging itself. This is the one place they are
 * certain to look.
 *
 * It disappears on its own once a mailbox is connected, so dismissal is only
 * for somebody who has decided not to — and it is remembered per browser
 * rather than in the database, which is the right weight for a suggestion.
 *
 * The reconnect variant is dismissed separately: having waved away the
 * invitation to connect months ago should not hide the fact that a working
 * connection has since expired.
 */
type Nudge = 'connect' | 'reconnect'

const COPY: Record<
  Nudge,
  { title: string; body: string; action: string; href: string; tone: string; icon: typeof MailIcon }
> = {
  connect: {
    title: 'Log your email automatically',
    body: 'Connect Gmail and messages with people already in the CRM appear on their timeline by themselves. Read-only — nothing is ever sent from here.',
    action: 'Connect Gmail',
    href: '/settings/mailboxes',
    tone: 'border-brand-200 bg-brand-50 text-brand-800',
    icon: MailIcon,
  },
  reconnect: {
    title: 'Your mailbox needs reconnecting',
    body: 'Google ended the authorisation, which it does about weekly while this app is in testing. Nothing already logged is lost and syncing resumes where it stopped.',
    action: 'Reconnect',
    href: '/settings/mailboxes',
    tone: 'border-amber-200 bg-amber-50 text-amber-900',
    icon: AlertIcon,
  },
}

export function MailboxNudge({ nudge }: { nudge: Nudge }) {
  // Hidden until the check has run, so a dismissed banner never flashes up.
  const [visible, setVisible] = useState(false)
  const key = `flo-crm-mailbox-nudge-${nudge}`

  useEffect(() => {
    try {
      setVisible(localStorage.getItem(key) !== 'dismissed')
    } catch {
      // Private mode, or storage disabled. Showing it is the safer default.
      setVisible(true)
    }
  }, [key])

  if (!visible) return null

  const { title, body, action, href, tone, icon: Icon } = COPY[nudge]

  return (
    <div className={`mb-5 flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3 ${tone}`}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-sm opacity-90">{body}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Link href={href} className="btn-primary px-3 py-1.5 text-xs">
          {action}
        </Link>
        <button
          type="button"
          className="px-2 py-1.5 text-xs underline-offset-2 opacity-70 hover:underline hover:opacity-100"
          onClick={() => {
            try {
              localStorage.setItem(key, 'dismissed')
            } catch {
              // Nothing to remember it with; hiding it for this page is enough.
            }
            setVisible(false)
          }}
        >
          Not now
        </button>
      </div>
    </div>
  )
}
