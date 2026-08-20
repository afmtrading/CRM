import { describe, expect, it } from 'vitest'

import { placeNames } from '@/lib/geography'

/*
 * The bug this exists to prevent: a list grouped by "Base Country" whose
 * headings read CA and US, and a filter box you have to know to type a code
 * into. The nine trading regions live in the same list, coded from the ISO
 * user-assigned X series, and have to lead it.
 */
describe('placeNames', () => {
  const places = placeNames([
    { code: 'XN', name: 'North America', kind: 'region' },
    { code: 'XE', name: 'Europe', kind: 'region' },
    { code: 'CA', name: 'Canada', kind: 'country' },
    { code: 'US', name: 'United States', kind: 'country' },
  ])

  it('reads a code as its name, region or country alike', () => {
    expect(places.country('CA')).toBe('Canada')
    expect(places.country('XN')).toBe('North America')
  })

  /*
   * A row carrying a code the reference table has never heard of — imported
   * before the list existed, or since retired — reads as the code rather than
   * as a blank. A blank looks like missing data; this data is present and only
   * unrecognised.
   */
  it('falls back to the code rather than to nothing', () => {
    expect(places.country('ZZ')).toBe('ZZ')
  })

  /* Asked for explicitly: the regions come first, then the countries. */
  it('puts the regions at the top of the list', () => {
    expect(places.countryOptions.map((option) => option.value)).toEqual(['XN', 'XE', 'CA', 'US'])
  })

  /*
   * Global is a region like the other nine, sorted to the front by the column
   * the query orders on rather than by anything here — placeNames keeps the
   * order it is given. This asserts it survives the trip, since a catch-all
   * that lands halfway down the list is one nobody finds.
   */
  it('keeps Global at the head of the list it was handed', () => {
    const withGlobal = placeNames([
      { code: 'XG', name: 'Global', kind: 'region' },
      { code: 'XN', name: 'North America', kind: 'region' },
      { code: 'CA', name: 'Canada', kind: 'country' },
    ])

    expect(withGlobal.countryOptions[0]).toEqual({ value: 'XG', label: 'Global' })
    expect(withGlobal.country('XG')).toBe('Global')
  })

  it('keeps the two kinds separable for a form that wants headings', () => {
    expect(places.regions.map((option) => option.label)).toEqual(['North America', 'Europe'])
    expect(places.countries.map((option) => option.label)).toEqual(['Canada', 'United States'])
  })

  /* A place with no kind is a country — the column defaults that way. */
  it('treats an unlabelled place as a country', () => {
    const legacy = placeNames([{ code: 'MX', name: 'Mexico' }])
    expect(legacy.countries).toHaveLength(1)
    expect(legacy.regions).toHaveLength(0)
  })

  it('survives an empty reference table', () => {
    const none = placeNames([])
    expect(none.country('CA')).toBe('CA')
    expect(none.countryOptions).toEqual([])
  })
})
