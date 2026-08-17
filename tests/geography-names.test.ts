import { describe, expect, it } from 'vitest'

import { placeNames } from '@/lib/geography'

/*
 * The bug this exists to prevent: a list grouped by "Based in" whose headings
 * read CA and US, and a filter box you have to know to type a code into.
 */
describe('placeNames', () => {
  const places = placeNames(
    [
      { code: 'CA', name: 'Canada' },
      { code: 'US', name: 'United States' },
    ],
    [
      { code: 'CA-AB', name: 'Alberta' },
      { code: 'US-TX', name: 'Texas' },
    ],
  )

  it('reads a country code as its name', () => {
    expect(places.country('CA')).toBe('Canada')
    expect(places.country('US')).toBe('United States')
  })

  it('reads a region code as its name', () => {
    expect(places.region('CA-AB')).toBe('Alberta')
  })

  /*
   * A row carrying a code the reference table has never heard of — imported
   * before the list existed, or since retired — reads as the code rather than
   * as a blank. A blank looks like missing data; this data is present and only
   * unrecognised.
   */
  it('falls back to the code rather than to nothing', () => {
    expect(places.country('ZZ')).toBe('ZZ')
    expect(places.region('ZZ-99')).toBe('ZZ-99')
  })

  /* The two namespaces stay separate: a region code is not a country. */
  it('does not answer for the wrong kind of place', () => {
    expect(places.country('CA-AB')).toBe('CA-AB')
    expect(places.region('CA')).toBe('CA')
  })

  it('offers options keyed by code and labelled by name', () => {
    expect(places.countryOptions).toEqual([
      { value: 'CA', label: 'Canada' },
      { value: 'US', label: 'United States' },
    ])
    expect(places.regionOptions).toEqual([
      { value: 'CA-AB', label: 'Alberta' },
      { value: 'US-TX', label: 'Texas' },
    ])
  })

  it('survives empty reference tables', () => {
    const none = placeNames([], [])
    expect(none.country('CA')).toBe('CA')
    expect(none.countryOptions).toEqual([])
  })
})
