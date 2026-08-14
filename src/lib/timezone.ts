/**
 * The organization's clock.
 *
 * One zone per organization rather than per viewer, because a report is a
 * statement about the business: two people reading the same figure in different
 * cities have to see the same number. The browser's zone is friendlier on a
 * single record and wrong the moment anything is totalled.
 *
 * Most of the conversion happens in SQL — deal_ledger returns days already
 * resolved, so nothing downstream has to think about it. What is left here is
 * the part SQL cannot answer: what today is, from the application's side of the
 * connection.
 */

/** Used when an organization predates the column, and by the database default. */
export const DEFAULT_TIMEZONE = 'America/Toronto'

/**
 * The zones offered in settings.
 *
 * A short list rather than all six hundred IANA names. These are where the
 * business actually operates, and a list somebody can read is worth more than
 * one that is complete — the database accepts any valid zone, so nothing is
 * permanently out of reach if that changes.
 */
export const TIMEZONES: { value: string; label: string }[] = [
  { value: 'America/Toronto', label: 'Toronto — Eastern' },
  { value: 'America/Vancouver', label: 'Vancouver — Pacific' },
  { value: 'America/Edmonton', label: 'Edmonton — Mountain' },
  { value: 'America/Winnipeg', label: 'Winnipeg — Central' },
  { value: 'America/Halifax', label: 'Halifax — Atlantic' },
  { value: 'America/St_Johns', label: "St John's — Newfoundland" },
  { value: 'America/New_York', label: 'New York — Eastern' },
  { value: 'America/Chicago', label: 'Chicago — Central' },
  { value: 'America/Denver', label: 'Denver — Mountain' },
  { value: 'America/Los_Angeles', label: 'Los Angeles — Pacific' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Shanghai', label: 'Shanghai' },
  { value: 'Asia/Kolkata', label: 'Kolkata' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'UTC', label: 'UTC' },
]

/**
 * Whether the runtime knows this zone.
 *
 * Checked by construction rather than against a list, so a zone the database
 * accepts but this Node build does not is caught before it reaches a formatter
 * and throws mid-render.
 */
export function isValidTimeZone(value: string): boolean {
  if (!value) return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** Falls back rather than throwing: a bad setting should not blank a page. */
export function safeTimeZone(value: string | null | undefined): string {
  return value && isValidTimeZone(value) ? value : DEFAULT_TIMEZONE
}

/**
 * An instant, as the calendar day it fell on in a given zone.
 *
 * en-CA formats as YYYY-MM-DD, which is the same shape the database returns for
 * a date column and the same shape an <input type="date"> submits — so a day
 * from here compares directly against either with a string comparison, and
 * there is no third representation to get wrong.
 */
export function dayIn(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/** Today, on the organization's clock. What "overdue" and "this month" mean. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return dayIn(now, timeZone)
}

/**
 * How the zone reads next to a date, for the one line of explanation a report
 * owes anybody wondering why a deal is filed on the day it is.
 */
export function timeZoneLabel(timeZone: string): string {
  const zone = safeTimeZone(timeZone)
  return TIMEZONES.find((option) => option.value === zone)?.label ?? zone.replace(/_/g, ' ')
}

/** The short name the zone is going by right now — EST, PDT, GMT+4. */
export function timeZoneAbbreviation(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    timeZoneName: 'short',
  }).formatToParts(now)

  return parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
}
