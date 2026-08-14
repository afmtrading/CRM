import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TIMEZONE,
  TIMEZONES,
  dayIn,
  isValidTimeZone,
  safeTimeZone,
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
