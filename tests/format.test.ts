import { describe, expect, it } from 'vitest'

import { dueLabel, formatDate, formatDateTime, formatDay } from '../src/lib/format'

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
