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
 * How far ahead of UTC the zone's wall clock reads at a given instant, in
 * milliseconds. Positive east of Greenwich, negative west of it.
 *
 * Read at an instant rather than looked up per zone, because the answer moves:
 * Toronto is five hours behind in January and four in July.
 */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    // Without this, midnight formats as hour 24 and the arithmetic lands a day
    // out — the one place this calculation is actually used.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)

  const at = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0')

  const wallClock = Date.UTC(
    at('year'),
    at('month') - 1,
    at('day'),
    at('hour'),
    at('minute'),
    at('second'),
  )

  return wallClock - instant.getTime()
}

/**
 * The instant a given calendar day began in a zone.
 *
 * `dayIn` goes one way — an instant to the day it fell on. This goes the other,
 * which is what a query needs: `created_at` is a timestamptz, so filtering to
 * "this month" means comparing against a moment, not a date string.
 *
 * `day` is YYYY-MM-DD, the shape `dayIn` returns and a date column stores.
 */
export function startOfDayIn(day: string, timeZone: string): Date {
  const zone = safeTimeZone(timeZone)
  const asIfUtc = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(asIfUtc.getTime())) return asIfUtc

  /*
   * Subtracting the offset turns "midnight, read as UTC" into the real instant.
   * The catch is that the offset has to be read somewhere, and the only instant
   * available to read it at is the guess — which sits up to a day from the
   * answer, and can therefore fall on the far side of a clock change.
   *
   * So read it again at the candidate. If the zone was on a different offset
   * there, that is the one that governs the day's first moment, and one more
   * subtraction lands on it. Two passes are enough: offsets shift by an hour,
   * never by enough to cross a second boundary.
   */
  const guess = offsetMsAt(asIfUtc, zone)
  const candidate = new Date(asIfUtc.getTime() - guess)
  const actual = offsetMsAt(candidate, zone)

  return actual === guess ? candidate : new Date(asIfUtc.getTime() - actual)
}

/**
 * The instant the current month began, on the organization's clock.
 *
 * What the "New this month" counts on the record lists are asking for. The
 * server runs in UTC, so a contact added at nine on the evening of the 31st in
 * Toronto was already next month as far as `new Date()` was concerned.
 */
export function startOfMonthIn(timeZone: string, now: Date = new Date()): Date {
  const today = todayIn(timeZone, now)
  if (!today) return new Date(NaN)

  return startOfDayIn(`${today.slice(0, 7)}-01`, timeZone)
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
