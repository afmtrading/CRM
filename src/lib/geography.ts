/**
 * Countries and trading regions, which are stored as codes and read as names.
 *
 * `companies.based_in` holds `CA`, `sells_in` holds an array of the same. That
 * is the right thing to store — a code is stable and a name is a translation —
 * but it means every screen that shows one has to look it up, and any screen
 * that forgets shows a group heading reading "CA" or a filter box you have to
 * know to type "CA" into.
 *
 * The trading regions live in the same table, coded from the ISO 3166-1
 * user-assigned X series, so "sells across Europe" is one value rather than a
 * list of forty. They sort ahead of the countries because they are the coarser
 * answer and the one people reach for first, and Global — everywhere, as one
 * value rather than as ten ticks — sorts ahead of them.
 *
 * Reference data rather than tenant data: the same list for every organization,
 * small enough that a list page can load it without thinking about it.
 */

export interface Place {
  code: string
  name: string
  /** 'region' for a trading bloc, 'country' for an ISO 3166-1 entry. */
  kind?: string
}

export interface PlaceNames {
  /** A code as a person would read it, falling back to the code. */
  country: (code: string) => string
  /** Options for a select, regions first and then countries. */
  countryOptions: { value: string; label: string }[]
  /** The same, split so a form can show them under headings. */
  regions: { value: string; label: string }[]
  countries: { value: string; label: string }[]
}

/**
 * An unknown code comes back as itself. A row carrying a code that has since
 * been retired should read as something slightly wrong rather than as nothing
 * at all — a blank cell looks like missing data, and this is data that is
 * present but unrecognised.
 */
export function placeNames(places: Place[]): PlaceNames {
  const byCode = new Map(places.map((place) => [place.code, place.name]))
  const option = (place: Place) => ({ value: place.code, label: place.name })

  const regions = places.filter((place) => place.kind === 'region').map(option)
  const countries = places.filter((place) => place.kind !== 'region').map(option)

  return {
    country: (code) => byCode.get(code) ?? code,
    countryOptions: [...regions, ...countries],
    regions,
    countries,
  }
}
