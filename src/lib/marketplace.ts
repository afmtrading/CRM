/**
 * What distinguishes one marketplace from another.
 *
 * A per-category rate card lived here and was taken out. Keeping it true meant
 * a row per category per platform per direction, and the decision it existed to
 * support — is this channel expensive or cheap — needs three values, not three
 * decimal places. The percentages became a note somebody writes in their own
 * words, and the comparison became one field.
 *
 * What is left is small and pure, which is the right size: the shape of a
 * marketplace is mostly option lists, and an option list needs no arithmetic.
 */

/** The select lists a marketplace draws on, all of them editable in Settings. */
export const MARKETPLACE_OPTION_FIELDS = {
  type: 'marketplace_type',
  fulfilment: 'marketplace_fulfilment',
  payment: 'marketplace_payment',
  sellingCost: 'marketplace_selling_cost',
  audience: 'marketplace_audience',
  inventoryType: 'marketplace_inventory_type',
  accountStatus: 'marketplace_account_status',
  /*
   * The company's own list. A marketplace has no priority of its own — see
   * 20260247000000 — so this key is here for reading the company's, not for
   * writing anything on the profile.
   */
  priority: 'priority',
} as const

export interface MarketplaceDirections {
  sells_through: boolean
  sources_from: boolean
}

/** Which directions this marketplace is used in, as a sentence. */
export function directionLabel({ sells_through, sources_from }: MarketplaceDirections): string {
  if (sells_through && sources_from) return 'Sell and source'
  if (sources_from) return 'Source only'
  return 'Sell only'
}

/**
 * Yes, No, or nothing said.
 *
 * Null is a third answer rather than a missing one: a platform whose buyer's
 * premium nobody has looked up is not a platform without one, and rendering
 * "No" for both would put a fact on screen that nobody established.
 */
export function yesNo(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value ? 'Yes' : 'No'
}

/**
 * How a form field reaches the database as a three-state boolean.
 *
 * '' is "not recorded" and has to arrive as null. A select with a blank option
 * posts the empty string, and treating that as false would quietly assert
 * something about every marketplace nobody had got to yet.
 */
export function parseYesNo(value: FormDataEntryValue | null): boolean | null {
  const text = String(value ?? '').trim()
  if (text === '') return null
  return text === 'true' || text === 'yes' || text === 'on'
}

/**
 * Which of a marketplace's fields a submitted form is carrying.
 *
 * The record is edited from three cards — what the channel is, what it costs,
 * and the account behind it — and each is its own form posting to one action.
 * That is only safe if a form leaves the fields it does not carry alone, and
 * HTML gives the server no way to tell "this box was cleared" from "this box
 * was not on the page": an unticked checkbox and an absent one both post
 * nothing, and an empty text input and an absent one both arrive as ''.
 *
 * So each form names itself, and everything outside the named group is sent as
 * null — which `update_marketplace` reads as "leave it". Without this, saving
 * the fees card would empty the marketplace type, the audience and the store
 * name, because those are exactly the shapes that cannot speak for themselves.
 *
 * A form that names nothing carries everything, which is what the single form
 * this replaced did. A name nobody recognises carries nothing, so a typo
 * writes no fields rather than the wrong ones.
 */
export type MarketplaceSection = 'detail' | 'fees' | 'account'

const MARKETPLACE_SECTIONS: MarketplaceSection[] = ['detail', 'fees', 'account']

export function marketplaceSections(
  raw: FormDataEntryValue | null | undefined,
): Record<MarketplaceSection, boolean> {
  const name = String(raw ?? '').trim()
  if (name === '') return { detail: true, fees: true, account: true }

  return {
    detail: name === 'detail',
    fees: name === 'fees',
    account: name === 'account',
  }
}

/** Whether a name is one of the three, for a caller that wants to check first. */
export function isMarketplaceSection(name: string): name is MarketplaceSection {
  return (MARKETPLACE_SECTIONS as string[]).includes(name)
}
