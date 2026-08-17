/**
 * Currencies the app offers. One list, so a product and the deal it lands on
 * can never drift onto different menus.
 */
export const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP'] as const

/**
 * A currency code Intl will accept, or null.
 *
 * `Intl.NumberFormat` throws a RangeError on anything that is not exactly three
 * ASCII letters — an empty string, null, 'US', a padded ' USD '. Thrown from a
 * server component it does not blank a cell, it blanks the page, and a money
 * formatter is the last thing that should be able to do that.
 *
 * Every currency column is `not null` today, so this guards against tomorrow:
 * an import that writes an empty string, a new nullable column, an RPC that
 * returns one. 'XYZ' is deliberately allowed through — Intl accepts any
 * well-formed code and renders it beside the number, which is the honest
 * outcome for a code this module has not heard of.
 */
export function usableCurrency(currency: string | null | undefined): string | null {
  const code = (currency ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

/**
 * What stands where the currency should have been.
 *
 * An amount with no currency is a data problem, and the first version of this
 * guard printed a bare number — which fixed the crash and hid the cause, since
 * "12.50" looks like a perfectly good figure. It says so now instead. Long and
 * awkward on purpose: this is meant to be noticed and then fixed, not lived
 * with.
 */
export const NO_CURRENCY = '(no currency)'

export function formatCurrency(value: number, currency = 'USD'): string {
  const code = usableCurrency(currency)

  // The number, and the fact that nobody knows what it is denominated in.
  if (!code) return `${formatAmount(value ?? 0)} ${NO_CURRENCY}`

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
    maximumFractionDigits: 0,
  }).format(value ?? 0)
}

/**
 * The same, to the cent.
 *
 * `formatCurrency` rounds to whole units, which is right for a deal worth
 * $40,000 and wrong for a piece price of $2.45 — rounded to the dollar, half a
 * price list becomes the same number. Anywhere the cents are the point, this is
 * the formatter.
 */
export function formatPrice(value: number, currency = 'USD'): string {
  const code = usableCurrency(currency)

  // Still to the cent, still without inventing a currency. See NO_CURRENCY.
  if (!code) {
    const amount = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value ?? 0)

    return `${amount} ${NO_CURRENCY}`
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value ?? 0)
}

/**
 * The amount without its currency, for places that show the code separately.
 *
 * `<Money>` in `src/components/money.tsx` pairs this with a symbol in front and
 * a coloured code standing to the right of the number.
 */
export function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value ?? 0)
}

/**
 * The symbol that goes in front of the number.
 *
 * Written out rather than taken from `Intl`, which renders CAD as `$` and USD
 * as `US$` in one locale and the reverse in another — a difference that reads
 * as a difference in kind when both sit on the same board. Here the symbol is
 * only ever decoration; the code to the right of the number is what actually
 * says which currency it is, so `$` for both dollars is honest.
 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  CAD: '$',
  USD: '$',
  EUR: '€',
  GBP: '£',
}

export function currencySymbol(currency: string | null | undefined): string {
  return CURRENCY_SYMBOLS[(currency ?? '').toUpperCase()] ?? ''
}

/**
 * A total per currency, for the places that used to add them all together.
 *
 * A column holding 10 CAD and 100 USD has no total: 110 of nothing is not a
 * number anybody can act on, and converting would need a rate the app does not
 * have and a date to apply it on. So each currency keeps its own subtotal and
 * the reader is told the truth — `$10 CAD · $100 USD`.
 */
export function totalsByCurrency(
  rows: { value?: number | string | null; currency?: string | null }[],
): { currency: string; total: number }[] {
  const totals = new Map<string, number>()

  for (const row of rows) {
    const currency = (row.currency ?? '').toUpperCase()
    totals.set(currency, (totals.get(currency) ?? 0) + Number(row.value ?? 0))
  }

  // The app's own order first, so a board's currencies always appear in the
  // same sequence and the eye can go straight to the one it wants.
  const rank = (currency: string) => {
    const index = (CURRENCIES as readonly string[]).indexOf(currency)
    return index === -1 ? CURRENCIES.length : index
  }

  return [...totals.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([currency, total]) => ({ currency, total }))
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
