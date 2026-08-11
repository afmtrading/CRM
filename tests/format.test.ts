import { describe, expect, it } from 'vitest'

import {
  currencyStyle,
  currencySymbol,
  dueLabel,
  formatAmount,
  formatDate,
  formatDateTime,
  formatDay,
  totalsByCurrency,
} from '../src/lib/format'

/*
 * These tests run in whatever zone the machine is in, so they assert on the
 * relationship between zones rather than on one literal string. That is the
 * property that actually matters: a day never moves, an instant always does.
 */

describe('formatDay', () => {
  it('shows a calendar date as written, whatever zone the reader is in', () => {
    // A close date of the 15th is the 15th in Toronto and in Tokyo. Formatting
    // it in local time would render 14 Aug for anyone west of UTC, which is the
    // bug this function exists to prevent.
    expect(formatDay('2026-08-15')).toContain('15')
    expect(formatDay('2026-08-15')).toContain('Aug')
  })

  it('does not slide backwards for a date at the start of a month', () => {
    expect(formatDay('2026-08-01')).toContain('1')
    expect(formatDay('2026-08-01')).toContain('Aug')
    expect(formatDay('2026-08-01')).not.toContain('Jul')
  })

  it('does not slide forwards for a date at the end of a month', () => {
    expect(formatDay('2026-08-31')).toContain('31')
    expect(formatDay('2026-08-31')).not.toContain('Sep')
  })

  it('renders a timestamp on its UTC day, ignoring the reader entirely', () => {
    expect(formatDay('2026-08-15T23:30:00.000Z')).toContain('15')
  })

  it('has nothing to show for an empty value', () => {
    expect(formatDay(null)).toBe('—')
    expect(formatDay(undefined)).toBe('—')
  })
})

describe('formatDateTime', () => {
  const instant = '2026-08-11T01:40:00.000Z' // 9:40 p.m. on the 10th in Toronto

  it('reads differently in different zones, because an instant is one moment', () => {
    expect(formatDateTime(instant, 'UTC')).not.toBe(formatDateTime(instant, 'America/Toronto'))
  })

  it('puts a late-evening Toronto timestamp on the Toronto day, not the UTC one', () => {
    // The exact failure that was reported: the server said 9:40 p.m. UTC on the
    // 11th while the reader's clock said 9:40 p.m. on the 10th.
    const toronto = formatDateTime(instant, 'America/Toronto')
    expect(toronto).toContain('10')
    expect(toronto).toContain('09:40')

    const utc = formatDateTime(instant, 'UTC')
    expect(utc).toContain('11')
    expect(utc).toContain('01:40')
  })

  it('has nothing to show for an empty value', () => {
    expect(formatDateTime(null)).toBe('—')
  })
})

describe('formatDate', () => {
  it('places an instant on the reader’s day, unlike formatDay', () => {
    const instant = '2026-08-11T01:40:00.000Z'

    expect(formatDate(instant, 'America/Toronto')).toContain('10')
    expect(formatDate(instant, 'UTC')).toContain('11')
    // formatDay always answers with the UTC day, whoever is asking.
    expect(formatDay(instant)).toContain('11')
  })
})

describe('dueLabel', () => {
  /**
   * Days are counted on the calendar, not in elapsed hours, and which calendar
   * is the whole question. These build the due date relative to "now" in a
   * chosen zone so the assertions hold whenever CI happens to run.
   */
  const inZone = (date: Date, timeZone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    }).format(date)

  const atNoonOn = (day: string) => `${day}T12:00:00.000Z`

  it('calls a task due later today "Today"', () => {
    const today = inZone(new Date(), 'UTC')
    expect(dueLabel(atNoonOn(today), 'UTC')).toEqual({ label: 'Today', tone: 'today' })
  })

  it('calls tomorrow "Tomorrow"', () => {
    const tomorrow = inZone(new Date(Date.now() + 86_400_000), 'UTC')
    expect(dueLabel(atNoonOn(tomorrow), 'UTC')).toEqual({ label: 'Tomorrow', tone: 'upcoming' })
  })

  it('counts whole days for something overdue', () => {
    const twoDaysAgo = inZone(new Date(Date.now() - 2 * 86_400_000), 'UTC')
    expect(dueLabel(atNoonOn(twoDaysAgo), 'UTC')).toEqual({
      label: '2d overdue',
      tone: 'overdue',
    })
  })

  /*
   * The reported class of bug: at 9 p.m. in Toronto it is already tomorrow in
   * UTC, so a task due tonight is "Today" to the person looking at it and
   * overdue to a server in London. The zone argument is what decides.
   *
   * Built relative to now rather than pinned to a date — an earlier version of
   * this test hard-coded an instant, which quietly stopped testing anything the
   * moment that date arrived and then failed outright the day after.
   */
  it('reads the same instant differently depending on whose calendar is asked', () => {
    // 01:00 UTC is always the previous evening in Toronto, whatever the season,
    // so this one moment sits on two different calendar days.
    const threeDaysOut = new Date(Date.now() + 3 * 86_400_000)
    const instant = `${threeDaysOut.toISOString().slice(0, 10)}T01:00:00.000Z`

    const toronto = dueLabel(instant, 'America/Toronto')
    const utc = dueLabel(instant, 'UTC')

    // Both describe the same moment; they disagree because the day does.
    expect(toronto.label).not.toBe(utc.label)
    expect(toronto.tone).toBe('upcoming')
    expect(utc.tone).toBe('upcoming')
  })

  it('has nothing to say about a task with no due date', () => {
    expect(dueLabel(null, 'UTC')).toEqual({ label: '—', tone: 'none' })
  })
})

describe('currency presentation', () => {
  it('formats the bare number, leaving the symbol and the code to <Money>', () => {
    // Intl's currency styles would put CAD and USD on different footings —
    // `$` for one and `US$` for the other — so the pieces are assembled here.
    expect(formatAmount(1200)).toBe('1,200')
    expect(formatAmount(1200)).not.toContain('$')
  })

  it('rounds to whole units, as the currency formatter does', () => {
    expect(formatAmount(1200.4)).toBe('1,200')
  })

  it('gives each currency its own colour', () => {
    const styles = ['CAD', 'USD', 'EUR', 'GBP'].map(currencyStyle)
    expect(new Set(styles).size).toBe(4)
  })

  it('does not care about case', () => {
    expect(currencyStyle('usd')).toBe(currencyStyle('USD'))
  })

  it('falls back rather than inventing a colour that collides with the four', () => {
    const fallback = currencyStyle('JPY')
    for (const known of ['CAD', 'USD', 'EUR', 'GBP']) {
      expect(fallback).not.toBe(currencyStyle(known))
    }
    expect(currencyStyle(null)).toBe(fallback)
  })
})

describe('currencySymbol', () => {
  it('gives both dollars the same sign, because the code is what tells them apart', () => {
    // Intl would render one of these as US$ depending on the locale, which
    // reads as a difference in kind between two currencies that are equals on
    // the board. The symbol is decoration; <Money> prints the code beside it.
    expect(currencySymbol('CAD')).toBe('$')
    expect(currencySymbol('USD')).toBe('$')
  })

  it('knows the other two', () => {
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('GBP')).toBe('£')
  })

  it('is case-insensitive, since the column is not', () => {
    expect(currencySymbol('usd')).toBe('$')
  })

  it('shows nothing rather than guessing at a currency it does not know', () => {
    expect(currencySymbol('JPY')).toBe('')
    expect(currencySymbol(null)).toBe('')
    expect(currencySymbol(undefined)).toBe('')
  })
})

describe('totalsByCurrency', () => {
  it('keeps each currency to itself rather than adding them into a lie', () => {
    // The bug this replaces: 10 CAD + 100 USD was rendered as "$110", labelled
    // with whichever currency happened to sort first.
    expect(
      totalsByCurrency([
        { value: 10, currency: 'CAD' },
        { value: 100, currency: 'USD' },
      ]),
    ).toEqual([
      { currency: 'CAD', total: 10 },
      { currency: 'USD', total: 100 },
    ])
  })

  it('adds up the rows that do share a currency', () => {
    expect(
      totalsByCurrency([
        { value: 100, currency: 'USD' },
        { value: 250, currency: 'USD' },
      ]),
    ).toEqual([{ currency: 'USD', total: 350 }])
  })

  it('orders currencies the way the app lists them, not the way they arrived', () => {
    const totals = totalsByCurrency([
      { value: 1, currency: 'GBP' },
      { value: 1, currency: 'USD' },
      { value: 1, currency: 'EUR' },
      { value: 1, currency: 'CAD' },
    ])
    expect(totals.map((entry) => entry.currency)).toEqual(['CAD', 'USD', 'EUR', 'GBP'])
  })

  it('puts anything unrecognised after the four the app offers', () => {
    const totals = totalsByCurrency([
      { value: 1, currency: 'JPY' },
      { value: 1, currency: 'USD' },
    ])
    expect(totals.map((entry) => entry.currency)).toEqual(['USD', 'JPY'])
  })

  it('treats a currency as the same one however it was cased', () => {
    expect(
      totalsByCurrency([
        { value: 5, currency: 'usd' },
        { value: 5, currency: 'USD' },
      ]),
    ).toEqual([{ currency: 'USD', total: 10 }])
  })

  it('reads a value that arrived as a string, which is how numeric columns come back', () => {
    expect(totalsByCurrency([{ value: '1200.50', currency: 'USD' }])).toEqual([
      { currency: 'USD', total: 1200.5 },
    ])
  })

  it('counts a missing value as nothing rather than dropping the row', () => {
    expect(
      totalsByCurrency([
        { value: null, currency: 'USD' },
        { value: 40, currency: 'USD' },
      ]),
    ).toEqual([{ currency: 'USD', total: 40 }])
  })

  it('has nothing to show for no rows, which is what an empty column is', () => {
    expect(totalsByCurrency([])).toEqual([])
  })
})
