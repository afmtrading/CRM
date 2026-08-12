import type { ContactMailabilityRow, MarketingConsent } from '@/lib/database.types'

/**
 * Consent, in the words a person uses rather than the values in the column.
 *
 * The law that matters here is the strict one — consent given *before*
 * sending, not an opt-out afterwards — so the labels say what the basis is,
 * not just that a box is ticked. "Implied" is the one people get wrong: it is
 * a real business relationship, and it expires.
 */

export const CONSENT_OPTIONS: {
  value: Exclude<MarketingConsent, 'unsubscribed'>
  label: string
  hint: string
}[] = [
  {
    value: 'express',
    label: 'Express consent',
    hint: 'They actively agreed — a form, a tick box, a signature. Does not expire.',
  },
  {
    value: 'implied',
    label: 'Implied consent',
    hint: 'An existing business relationship. Expires two years after the date below.',
  },
  {
    value: 'none',
    label: 'No consent',
    hint: 'Do not send marketing. They can still be called and emailed personally.',
  },
]

export const CONSENT_LABELS: Record<MarketingConsent, string> = {
  express: 'Express consent',
  implied: 'Implied consent',
  none: 'No consent',
  unsubscribed: 'Unsubscribed',
}

/** How long implied consent stands. Mirrors the interval in contact_mailability. */
export const IMPLIED_CONSENT_MONTHS = 24

export type BlockedReason = NonNullable<ContactMailabilityRow['blocked_reason']>

/**
 * Why somebody is being held back, said plainly enough to act on.
 *
 * These appear next to a count on the audience screen, so each one has to
 * answer "what would I do about it" rather than just naming a state.
 */
export const BLOCKED_REASONS: Record<BlockedReason, string> = {
  no_email: 'No email address',
  no_consent: 'No consent recorded',
  consent_expired: `Implied consent older than ${IMPLIED_CONSENT_MONTHS / 12} years`,
  unsubscribed: 'Unsubscribed',
  suppressed: 'Bounced or complained before',
  excluded: 'Excluded by hand',
}

/**
 * The manual override, as three choices rather than a checkbox.
 *
 * "Follow the rules" is a real answer and the one every contact starts on, so
 * it is an option rather than the absence of one.
 */
export const OVERRIDE_OPTIONS: { value: string; label: string; hint: string }[] = [
  {
    value: '',
    label: 'Follow the consent rules',
    hint: 'Decided by the consent basis recorded above.',
  },
  {
    value: 'true',
    label: 'Yes — send to them',
    hint: 'Overrides a missing or expired consent basis. Cannot override an unsubscribe or a bounce.',
  },
  {
    value: 'false',
    label: 'No — never send',
    hint: 'Excludes them from every campaign, whatever their consent says.',
  },
]

/** What the override says, for a record that has one. */
export function overrideLabel(value: boolean | null | undefined): string | null {
  if (value === true) return 'Yes — set by hand'
  if (value === false) return 'No — set by hand'
  return null
}

export function blockedLabel(reason: BlockedReason | null | undefined): string | null {
  return reason ? (BLOCKED_REASONS[reason] ?? 'Cannot be emailed') : null
}

/**
 * When implied consent runs out, or null if the question does not arise.
 *
 * Express consent has no expiry, and the other two states are not a countdown
 * to anything. Returned as a date so a record can warn before it lapses rather
 * than only after.
 */
export function impliedConsentExpiry(
  consent: MarketingConsent,
  consentAt: string | null | undefined,
): Date | null {
  if (consent !== 'implied' || !consentAt) return null

  const at = new Date(consentAt)
  if (Number.isNaN(at.getTime())) return null

  const expiry = new Date(at)
  expiry.setMonth(expiry.getMonth() + IMPLIED_CONSENT_MONTHS)
  return expiry
}

/**
 * A one-line summary of where a set of contacts stands.
 *
 * Written for the moment before somebody sends: how many will actually receive
 * it, and — separately, because it is the number people miss — how many will
 * not, and why.
 */
export function summariseAudience(rows: Pick<ContactMailabilityRow, 'blocked_reason'>[]): {
  mailable: number
  blocked: number
  reasons: { reason: BlockedReason; label: string; count: number }[]
} {
  const counts = new Map<BlockedReason, number>()
  let mailable = 0

  for (const row of rows) {
    if (!row.blocked_reason) {
      mailable += 1
      continue
    }
    counts.set(row.blocked_reason, (counts.get(row.blocked_reason) ?? 0) + 1)
  }

  // Ordered by how many rather than alphabetically: the biggest reason is the
  // one worth doing something about.
  const reasons = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({ reason, label: BLOCKED_REASONS[reason], count }))

  return { mailable, blocked: rows.length - mailable, reasons }
}
