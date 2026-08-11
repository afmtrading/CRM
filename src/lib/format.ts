/**
 * Currencies the app offers. One list, so a product and the deal it lands on
 * can never drift onto different menus.
 */
export const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP'] as const

export function formatCurrency(value: number, currency = 'CAD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value ?? 0)
}

/**
 * The amount without its currency, for places that show the code separately.
 *
 * A symbol in front is ambiguous the moment a second currency appears — `$`
 * reads as both CAD and USD, and a board holding both wants them told apart at
 * a glance. `<Money>` in `src/components/money.tsx` pairs this with a coloured
 * code standing to the right of the number.
 */
export function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-CA', { maximumFractionDigits: 0 }).format(value ?? 0)
}

/**
 * A colour per currency, so a mixed board is readable without reading.
 *
 * Chosen by the people who use it rather than derived from anything: CAD red,
 * USD blue, EUR amber, GBP green. Anything else falls back to slate rather
 * than inventing a colour that would collide with one of these four.
 */
export const CURRENCY_STYLES: Record<string, string> = {
  CAD: 'text-red-600',
  USD: 'text-blue-600',
  EUR: 'text-amber-600',
  GBP: 'text-emerald-600',
}

export function currencyStyle(currency: string | null | undefined): string {
  return CURRENCY_STYLES[(currency ?? '').toUpperCase()] ?? 'text-slate-500'
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-CA').format(value ?? 0)
}

export function formatPercent(value: number): string {
  return `${Math.round((value ?? 0) * 100)}%`
}

/**
 * Dates come in two kinds, and treating them alike is the classic timezone bug.
 *
 * A **day** is a calendar date with no time in it — an expected close date, a
 * birthday. It is the same day everywhere on earth, so it must never be shifted
 * by a zone: a deal closing on the 15th that reads as the 14th for anyone west
 * of UTC is simply wrong. `formatDay` pins to UTC to hold it still. Use it for
 * the `date` columns: expected_close_date, actual_close_date, birthday.
 *
 * An **instant** is a moment — created_at, last_synced_at, occurred_at. It
 * happened at one point in time and every reader should see it on their own
 * clock. `formatDate`/`formatDateTime` take a zone, and rendering them on the
 * server without one shows the server's zone, which on Vercel is UTC and is
 * nobody's. That is what `<DateTime>` in `src/components/date-time.tsx` exists
 * to avoid — prefer it over calling these directly from a server component.
 */
export function formatDay(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatDate(value: string | null | undefined, timeZone?: string): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  })
}

export function formatDateTime(value: string | null | undefined, timeZone?: string): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  })
}

export function contactName(contact: { first_name?: string | null; last_name?: string | null; email?: string | null }): string {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim()
  return name || contact.email || 'Unnamed contact'
}

export function initials(value: string): string {
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

export type DueTone = 'overdue' | 'today' | 'upcoming' | 'none'

/** The calendar day a moment falls on, in a given zone, as `YYYY-MM-DD`. */
function dayIn(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(date)
}

/**
 * Relative day label for due dates, so overdue work reads as overdue.
 *
 * "Today" is a question about the reader's calendar, not the server's. A task
 * due tonight is still today at 9 p.m. in Toronto while it is already tomorrow
 * in UTC — so the whole thing hinges on which zone decides where a day ends.
 * Omit `timeZone` in the browser to get the reader's own; `<DueDate>` in
 * `src/components/due-date.tsx` is what arranges that on a server-rendered page.
 */
export function dueLabel(
  due: string | null | undefined,
  timeZone?: string,
): { label: string; tone: DueTone } {
  if (!due) return { label: '—', tone: 'none' }

  // Compared as calendar days rather than elapsed hours: a task due in 20 hours
  // is "tomorrow" if it lands after midnight, and "today" if it does not.
  const dueDay = dayIn(new Date(due), timeZone)
  const today = dayIn(new Date(), timeZone)
  const days = Math.round((Date.parse(`${dueDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)

  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: 'overdue' }
  if (days === 0) return { label: 'Today', tone: 'today' }
  if (days === 1) return { label: 'Tomorrow', tone: 'upcoming' }
  return { label: formatDate(due, timeZone), tone: 'upcoming' }
}
