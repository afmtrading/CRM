/**
 * Countries and regions, which are stored as codes and read as names.
 *
 * `companies.based_in` holds `CA`, `based_in_region` holds `CA-AB`, and
 * `sells_in` / `sources_in` hold arrays of the former. That is the right thing
 * to store — a code is stable and a name is a translation — but it means every
 * screen that shows one has to look it up, and any screen that forgets shows a
 * group heading reading "CA" or a filter box you have to know to type "CA" into.
 *
 * The two tables are global reference data rather than tenant data: 249
 * countries and 64 subdivisions, the same for every organization, small enough
 * that a list page can load both without thinking about it.
 */

export interface Place {
  code: string
  name: string
}

export interface PlaceNames {
  /** A country code as a person would read it, falling back to the code. */
  country: (code: string) => string
  /** A region code as a person would read it, falling back to the code. */
  region: (code: string) => string
  /** Filter options, in the order the reference table returned them. */
  countryOptions: { value: string; label: string }[]
  regionOptions: { value: string; label: string }[]
}

/**
 * Kept as two maps rather than one.
 *
 * Subdivision codes are ISO 3166-2 and carry their country as a prefix, so
 * they could safely share a map with the 3166-1 country codes today. Two maps
 * means that stays true even if a reference table ever adopts a bare code, and
 * it costs nothing.
 *
 * An unknown code comes back as itself. A row imported before a country list
 * existed, or one carrying a code that has since been retired, should read as
 * something slightly wrong rather than as nothing at all — a blank cell looks
 * like missing data, and this is data that is present but unrecognised.
 */
export function placeNames(countries: Place[], subdivisions: Place[]): PlaceNames {
  const byCountry = new Map(countries.map((place) => [place.code, place.name]))
  const byRegion = new Map(subdivisions.map((place) => [place.code, place.name]))

  return {
    country: (code) => byCountry.get(code) ?? code,
    region: (code) => byRegion.get(code) ?? code,
    countryOptions: countries.map((place) => ({ value: place.code, label: place.name })),
    regionOptions: subdivisions.map((place) => ({ value: place.code, label: place.name })),
  }
}
