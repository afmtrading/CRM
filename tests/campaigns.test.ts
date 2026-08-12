import { describe, expect, it } from 'vitest'

import { isEditable, tallyRecipients, CAMPAIGN_STATUS_LABELS } from '../src/lib/campaigns'
import type { CampaignStatus } from '../src/lib/database.types'

describe('isEditable', () => {
  it('allows editing only while it is a draft', () => {
    // Once an audience exists and the drain has started, editing the subject
    // means two different messages go out under one name.
    expect(isEditable('draft')).toBe(true)
    for (const status of ['scheduled', 'sending', 'sent', 'paused', 'failed'] as CampaignStatus[]) {
      expect(isEditable(status)).toBe(false)
    }
  })
})

describe('CAMPAIGN_STATUS_LABELS', () => {
  it('names every status the database allows', () => {
    const statuses: CampaignStatus[] = [
      'draft',
      'scheduled',
      'sending',
      'sent',
      'paused',
      'failed',
    ]
    for (const status of statuses) {
      expect(CAMPAIGN_STATUS_LABELS[status]).toBeTruthy()
    }
  })
})

const rows = (...statuses: string[]) => statuses.map((status) => ({ status }))

describe('tallyRecipients', () => {
  it('counts nothing for an empty outbox', () => {
    const tally = tallyRecipients([])
    expect(tally.total).toBe(0)
    expect(tally.sent).toBe(0)
  })

  it('counts everything that reached the provider as sent', () => {
    // Otherwise the number falls as the webhooks arrive, which reads as
    // messages going missing.
    const tally = tallyRecipients(rows('sent', 'delivered', 'opened', 'clicked', 'bounced'))
    expect(tally.sent).toBe(5)
  })

  it('does not count a skipped or pending row as sent', () => {
    const tally = tallyRecipients(rows('skipped', 'pending', 'sending'))
    expect(tally.sent).toBe(0)
    expect(tally.skipped).toBe(1)
    expect(tally.pending).toBe(2)
  })

  it('treats an open as proof of delivery', () => {
    // A message that was read but whose delivery webhook never arrived is not a
    // message that failed to arrive.
    const tally = tallyRecipients(rows('opened'))
    expect(tally.delivered).toBe(1)
    expect(tally.opened).toBe(1)
  })

  it('treats a click as proof of an open, and so of delivery', () => {
    const tally = tallyRecipients(rows('clicked'))
    expect(tally.delivered).toBe(1)
    expect(tally.opened).toBe(1)
    expect(tally.clicked).toBe(1)
  })

  it('keeps bounces and complaints apart — they mean different things', () => {
    const tally = tallyRecipients(rows('bounced', 'complained', 'complained'))
    expect(tally.bounced).toBe(1)
    expect(tally.complained).toBe(2)
    // Both reached the provider, so both count as sent.
    expect(tally.sent).toBe(3)
    // Neither was delivered to a person who wanted it.
    expect(tally.delivered).toBe(0)
  })

  it('counts a provider refusal as failed rather than sent', () => {
    const tally = tallyRecipients(rows('failed'))
    expect(tally.failed).toBe(1)
    expect(tally.sent).toBe(0)
  })

  it('adds up a realistic campaign', () => {
    const tally = tallyRecipients(
      rows(
        ...Array(40).fill('delivered'),
        ...Array(12).fill('opened'),
        ...Array(3).fill('clicked'),
        ...Array(2).fill('bounced'),
        'complained',
        ...Array(7).fill('skipped'),
        ...Array(5).fill('pending'),
      ),
    )

    expect(tally.total).toBe(70)
    expect(tally.sent).toBe(58)
    expect(tally.delivered).toBe(55)
    expect(tally.opened).toBe(15)
    expect(tally.clicked).toBe(3)
    expect(tally.skipped).toBe(7)
    expect(tally.pending).toBe(5)
  })
})
