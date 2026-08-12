import { describe, expect, it } from 'vitest'

import {
  BLOCKED_REASONS,
  blockedLabel,
  CONSENT_LABELS,
  CONSENT_OPTIONS,
  IMPLIED_CONSENT_MONTHS,
  impliedConsentExpiry,
  summariseAudience,
} from '../src/lib/consent'
import type { ContactMailabilityRow } from '../src/lib/database.types'

const blocked = (reason: ContactMailabilityRow['blocked_reason']) => ({ blocked_reason: reason })

describe('consent options', () => {
  it('does not offer to mark somebody unsubscribed on their behalf', () => {
    // Unsubscribing is a decision only the person themselves makes; offering it
    // in a picker is how it gets undone by accident.
    expect(CONSENT_OPTIONS.map((option) => option.value)).toEqual(['express', 'implied', 'none'])
  })

  it('has a label for every state a contact can actually be in', () => {
    expect(Object.keys(CONSENT_LABELS).sort()).toEqual(
      ['express', 'implied', 'none', 'unsubscribed'].sort(),
    )
  })

  it('explains that implied consent expires, because that is the part people miss', () => {
    const implied = CONSENT_OPTIONS.find((option) => option.value === 'implied')
    expect(implied?.hint.toLowerCase()).toContain('expires')
  })
})

describe('impliedConsentExpiry', () => {
  it('counts two years from the date consent was given', () => {
    const expiry = impliedConsentExpiry('implied', '2026-03-01T00:00:00.000Z')
    expect(expiry?.getUTCFullYear()).toBe(2028)
    expect(IMPLIED_CONSENT_MONTHS).toBe(24)
  })

  it('has no answer for express consent, which does not expire', () => {
    expect(impliedConsentExpiry('express', '2020-01-01T00:00:00.000Z')).toBeNull()
  })

  it('has no answer without a date — that case is handled as already expired', () => {
    expect(impliedConsentExpiry('implied', null)).toBeNull()
  })

  it('has no answer for the states that are not a countdown', () => {
    expect(impliedConsentExpiry('none', '2026-01-01T00:00:00.000Z')).toBeNull()
    expect(impliedConsentExpiry('unsubscribed', '2026-01-01T00:00:00.000Z')).toBeNull()
  })

  it('shrugs at a date it cannot read rather than returning an invalid one', () => {
    expect(impliedConsentExpiry('implied', 'not a date')).toBeNull()
  })
})

describe('blockedLabel', () => {
  it('says something a person could act on for every reason the view returns', () => {
    for (const reason of Object.keys(BLOCKED_REASONS) as (keyof typeof BLOCKED_REASONS)[]) {
      expect(blockedLabel(reason)).toBeTruthy()
    }
  })

  it('says nothing when nothing is wrong', () => {
    expect(blockedLabel(null)).toBeNull()
    expect(blockedLabel(undefined)).toBeNull()
  })
})

describe('summariseAudience', () => {
  it('counts who will actually receive it', () => {
    const summary = summariseAudience([
      blocked(null),
      blocked(null),
      blocked('no_consent'),
      blocked('unsubscribed'),
    ])

    expect(summary.mailable).toBe(2)
    expect(summary.blocked).toBe(2)
  })

  it('leads with the biggest reason, since that is the one worth fixing', () => {
    const summary = summariseAudience([
      blocked('unsubscribed'),
      blocked('no_consent'),
      blocked('no_consent'),
      blocked('no_consent'),
      blocked('no_email'),
      blocked('no_email'),
    ])

    expect(summary.reasons.map((entry) => entry.reason)).toEqual([
      'no_consent',
      'no_email',
      'unsubscribed',
    ])
    expect(summary.reasons[0].count).toBe(3)
  })

  it('has nothing to report about an empty selection', () => {
    expect(summariseAudience([])).toEqual({ mailable: 0, blocked: 0, reasons: [] })
  })

  it('reports a selection nobody may be emailed as exactly that', () => {
    // The case that matters most: it must not read as "ready to send".
    const summary = summariseAudience([blocked('no_consent'), blocked('no_consent')])
    expect(summary.mailable).toBe(0)
    expect(summary.blocked).toBe(2)
  })
})
