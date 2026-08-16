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
  /* The contacts' list, deliberately reused: "Critical" has to mean one thing. */
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
