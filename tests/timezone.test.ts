import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TIMEZONE,
  TIMEZONES,
  dayIn,
  isValidTimeZone,
  safeTimeZone,
  startOfDayIn,
  startOfMonthIn,
  timeZoneLabel,
  todayIn,
} from '../src/lib/timezone'

describe('an instant as a calendar day', () => {
  /*
   * The bug this whole module exists for. A deal raised at 8pm on 13 August in
   * Toronto is 03:00 on the 14th in UTC, and every report used to file it under
   * the 14th — so a month's figures ran from 8pm on the last day of the month
   * before.
   */
  it('files a late evening in the organization’s day, not the following UTC one', () => {
    const instant = '2026-08-14T03:00:00Z'
    expect(dayIn(instant, 'America/Toronto')).toBe('2026-08-13')
    expect(dayIn(instant, 'UTC')).toBe('2026-08-14')
  })

  it('files an early morning the same way, in the other direction', () => {
    // 9am in Sydney on the 14th is still the 13th in UTC.
    const instant = '2026-08-13T23:00:00Z'
    expect(dayIn(instant, 'Australia/Sydney')).toBe('2026-08-14')
    expect(dayIn(instant, 'UTC')).toBe('2026-08-13')
  })

  it('returns the shape the database and a date input both use', () => {
    expect(dayIn('2026-01-05T12:00:00Z', 'UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Zero-padded, so a string comparison against a date column is a date
    // comparison — which is what every range filter in the app relies on.
    expect(dayIn('2026-01-05T12:00:00Z', 'UTC')).toBe('2026-01-05')
  })

  it('handles the day a zone changes its offset', () => {
    // 2026-11-01 is the end of daylight saving in Toronto. 05:30 UTC is 01:30
    // local either side of the change, and still the 1st.
    expect(dayIn('2026-11-01T05:30:00Z', 'America/Toronto')).toBe('2026-11-01')
    // 03:30 UTC on 8 March is 22:30 on the 7th, the evening the clocks go forward.
    expect(dayIn('2026-03-08T03:30:00Z', 'America/Toronto')).toBe('2026-03-07')
  })

  it('accepts a Date as readily as a string', () => {
    expect(dayIn(new Date('2026-08-14T03:00:00Z'), 'America/Toronto')).toBe('2026-08-13')
  })

  it('gives nothing back for something that is not a date', () => {
    expect(dayIn('not a date', 'UTC')).toBe('')
  })

  it('reads today on the organization’s clock', () => {
    expect(todayIn('America/Toronto', new Date('2026-08-14T03:00:00Z'))).toBe('2026-08-13')
  })
})

describe('choosing a zone', () => {
  it('recognises a real one', () => {
    expect(isValidTimeZone('America/Toronto')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
  })

  it('rejects one the runtime cannot format', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })

  /*
   * A bad setting should cost a wrong day, not a blank page — dayIn is called
   * during render, and an exception there takes the whole report down.
   */
  it('falls back rather than throwing', () => {
    expect(safeTimeZone('Mars/Olympus_Mons')).toBe(DEFAULT_TIMEZONE)
    expect(safeTimeZone(null)).toBe(DEFAULT_TIMEZONE)
    expect(() => dayIn('2026-08-14T03:00:00Z', 'nonsense')).not.toThrow()
  })

  it('offers only zones it can actually format', () => {
    for (const zone of TIMEZONES) {
      expect(isValidTimeZone(zone.value)).toBe(true)
      expect(zone.label).toBeTruthy()
    }
  })

  it('includes the default among the choices', () => {
    expect(TIMEZONES.map((zone) => zone.value)).toContain(DEFAULT_TIMEZONE)
  })

  it('names a zone in words, and copes with one that is not on the list', () => {
    expect(timeZoneLabel('America/Toronto')).toBe('Toronto — Eastern')
    expect(timeZoneLabel('Africa/Cairo')).toBe('Africa/Cairo')
  })
})

describe('the instant a day began', () => {
  it('is midnight on the organization’s clock, not on the server’s', () => {
    // Toronto is four hours behind UTC in August, so its 1 August began at
    // 04:00 UTC. The server's own new Date() would have said 00:00.
    expect(startOfDayIn('2026-08-01', 'America/Toronto').toISOString()).toBe(
      '2026-08-01T04:00:00.000Z',
    )
    expect(startOfDayIn('2026-08-01', 'UTC').toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('follows the zone across a change of offset', () => {
    // Five hours behind in January, four in August. A fixed offset would put
    // one of these two an hour out.
    expect(startOfDayIn('2026-01-01', 'America/Toronto').toISOString()).toBe(
      '2026-01-01T05:00:00.000Z',
    )
    expect(startOfDayIn('2026-08-01', 'America/Toronto').toISOString()).toBe(
      '2026-08-01T04:00:00.000Z',
    )
  })

  it('works east of Greenwich, where the day starts before UTC does', () => {
    // Sydney is eleven hours ahead in January, so its 1 January began at 13:00
    // UTC on 31 December.
    expect(startOfDayIn('2026-01-01', 'Australia/Sydney').toISOString()).toBe(
      '2025-12-31T13:00:00.000Z',
    )
  })

  /*
   * The reason there is a correction pass. The offset has to be read at some
   * instant, and the only one available is the guess — which can sit on the
   * far side of the very clock change the day is being measured against.
   */
  it('lands on midnight even when the guess falls the other side of a clock change', () => {
    // Sydney puts its clocks forward at 2am on 4 October 2026, so midnight that
    // day is still +10 while noon is +11. Reading the offset at the guess gives
    // +11; the answer needs +10.
    const start = startOfDayIn('2026-10-04', 'Australia/Sydney')
    expect(start.toISOString()).toBe('2026-10-03T14:00:00.000Z')
    expect(dayIn(start, 'Australia/Sydney')).toBe('2026-10-04')

    // And the same on the way back, in the western hemisphere.
    const spring = startOfDayIn('2026-03-08', 'America/Toronto')
    expect(dayIn(spring, 'America/Toronto')).toBe('2026-03-08')
  })

  it('is the first moment of the day, so a record made at midnight counts', () => {
    for (const zone of ['America/Toronto', 'Australia/Sydney', 'Asia/Kolkata', 'UTC']) {
      for (const day of ['2026-01-01', '2026-03-08', '2026-07-01', '2026-11-01']) {
        expect(dayIn(startOfDayIn(day, zone), zone)).toBe(day)
        // One millisecond earlier belongs to the day before — which is what
        // makes a >= comparison against it exact rather than approximate.
        expect(dayIn(new Date(startOfDayIn(day, zone).getTime() - 1), zone)).not.toBe(day)
      }
    }
  })

  it('falls back rather than throwing on a zone it does not know', () => {
    expect(() => startOfDayIn('2026-08-01', 'nonsense')).not.toThrow()
    expect(startOfDayIn('2026-08-01', 'nonsense').toISOString()).toBe(
      startOfDayIn('2026-08-01', DEFAULT_TIMEZONE).toISOString(),
    )
  })

  it('returns an invalid date for a day that is not one, rather than a wrong one', () => {
    expect(Number.isNaN(startOfDayIn('not-a-day', 'UTC').getTime())).toBe(true)
  })
})

describe('the instant this month began', () => {
  /*
   * The bug on the record lists. Between midnight UTC and midnight in Toronto
   * on the first of the month, the server had already rolled over and the
   * organization had not — so a contact added on the last evening of the month
   * was counted as new this month.
   */
  it('does not roll over until the organization’s month does', () => {
    // 1 August, 02:00 UTC — which is still 22:00 on 31 July in Toronto.
    const now = new Date('2026-08-01T02:00:00Z')

    expect(startOfMonthIn('America/Toronto', now).toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    )
    // The server's month had already turned over.
    expect(startOfMonthIn('UTC', now).toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('rolls over once the organization gets there', () => {
    // Four hours later: now it is August in Toronto too.
    const now = new Date('2026-08-01T06:00:00Z')
    expect(startOfMonthIn('America/Toronto', now).toISOString()).toBe(
      '2026-08-01T04:00:00.000Z',
    )
  })

  it('turns over early where the zone is ahead of UTC', () => {
    // 31 August, 23:00 UTC is already 09:00 on 1 September in Sydney.
    const now = new Date('2026-08-31T23:00:00Z')
    expect(dayIn(now, 'Australia/Sydney')).toBe('2026-09-01')
    expect(startOfMonthIn('Australia/Sydney', now).toISOString()).toBe(
      '2026-08-31T14:00:00.000Z',
    )
  })

  it('is always the first of the month on the organization’s clock', () => {
    for (const zone of ['America/Toronto', 'America/Los_Angeles', 'Australia/Sydney', 'UTC']) {
      for (const instant of ['2026-01-15T12:00:00Z', '2026-03-01T04:30:00Z', '2026-11-01T02:00:00Z']) {
        const start = startOfMonthIn(zone, new Date(instant))
        expect(dayIn(start, zone).slice(-2)).toBe('01')
        expect(dayIn(start, zone).slice(0, 7)).toBe(dayIn(new Date(instant), zone).slice(0, 7))
      }
    }
  })
})
