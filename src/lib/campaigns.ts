import type { CampaignStatus } from '@/lib/database.types'

/**
 * The words a campaign's state is described in, and the arithmetic of an
 * outbox.
 *
 * Deliberately free of server imports so it can be unit-tested directly and
 * used from either side. Resolving an audience needs a database and lives in
 * `audience.ts` next door.
 */

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  paused: 'Paused',
  failed: 'Failed',
}

/**
 * What each state means to somebody looking at the screen, rather than to the
 * database. "Scheduled" and "sending" both mean "you can no longer edit this",
 * and that is the part worth saying out loud.
 */
export const CAMPAIGN_STATUS_HINTS: Record<CampaignStatus, string> = {
  draft: 'Not going anywhere yet. Edit it freely.',
  scheduled: 'Waiting for its time. The wording is now fixed.',
  sending: 'Going out now, a batch at a time.',
  sent: 'Everybody on the audience reached a final state.',
  paused: 'Stopped. Nobody else will be sent to until it is resumed.',
  failed: 'Something went wrong that needs a person to look at.',
}

export const CAMPAIGN_STATUS_TONE: Record<CampaignStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  scheduled: 'bg-amber-100 text-amber-800',
  sending: 'bg-sky-100 text-sky-800',
  sent: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-slate-200 text-slate-700',
  failed: 'bg-rose-100 text-rose-700',
}

/**
 * A campaign may only be rewritten while it is a draft.
 *
 * Not fussiness. Once an audience exists and the drain has started, editing the
 * subject or the body means two different messages go out under one name, and
 * the record afterwards says nothing about which half got which.
 */
export function isEditable(status: CampaignStatus): boolean {
  return status === 'draft'
}

export interface RecipientTally {
  total: number
  pending: number
  sent: number
  delivered: number
  opened: number
  clicked: number
  bounced: number
  complained: number
  failed: number
  skipped: number
}

/**
 * Counts an outbox by what happened.
 *
 * `sent` counts every message that reached the provider, including the ones
 * that went on to be delivered, opened or bounced. Otherwise the number falls
 * as the webhooks arrive, which reads as messages going missing.
 */
export function tallyRecipients(rows: { status: string }[]): RecipientTally {
  const tally: RecipientTally = {
    total: rows.length,
    pending: 0,
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    bounced: 0,
    complained: 0,
    failed: 0,
    skipped: 0,
  }

  const reached = new Set(['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'])

  for (const row of rows) {
    if (row.status === 'pending' || row.status === 'sending') tally.pending += 1
    if (reached.has(row.status)) tally.sent += 1

    switch (row.status) {
      case 'delivered':
        tally.delivered += 1
        break
      // An open implies a delivery, and a click implies an open. Counting them
      // only in their own bucket would show a message that was read as one that
      // never arrived.
      case 'opened':
        tally.delivered += 1
        tally.opened += 1
        break
      case 'clicked':
        tally.delivered += 1
        tally.opened += 1
        tally.clicked += 1
        break
      case 'bounced':
        tally.bounced += 1
        break
      case 'complained':
        tally.complained += 1
        break
      case 'failed':
        tally.failed += 1
        break
      case 'skipped':
        tally.skipped += 1
        break
    }
  }

  return tally
}
