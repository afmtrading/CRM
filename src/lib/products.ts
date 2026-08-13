/**
 * The arithmetic behind a price list.
 *
 * Pure by design — no server imports, nothing from Supabase — so the pricing
 * rules can be unit tested directly and so the same function runs on the form
 * as the user types and on the record when it is read back. If those two ever
 * disagreed, the number somebody saw while typing would not be the number that
 * got saved.
 *
 * Product type, condition and status are deliberately NOT here. They are drawn
 * from field_options and edited in Settings → Fields, so there is no list in
 * the code that could claim to know what they are.
 */

/**
 * The one status value the code has an opinion about.
 *
 * `products.active` — which the deal picker and the catalogue list both filter
 * on — is derived from this by a database trigger: a product is on offer when
 * its status is "Active" and off offer whatever else it is called. That rule
 * survives an admin adding "Reserved" or "In Transit" without a deployment.
 * Renaming this particular option is the one edit that would misbehave, and it
 * misbehaves loudly — the whole catalogue leaves the deal form at once.
 */
export const PRODUCT_ACTIVE_STATUS = 'Active'

export function isOnOffer(status: string | null | undefined): boolean {
  return !status || status.trim().toLowerCase() === PRODUCT_ACTIVE_STATUS.toLowerCase()
}

// -----------------------------------------------------------------------------
// Pricing
// -----------------------------------------------------------------------------

/** Showroom and wholesale as shares of retail, until somebody says otherwise. */
export const SHOWROOM_SHARE = 0.7
export const WHOLESALE_SHARE = 0.3

/** Postgres hands numerics back as strings; forms hand everything back as strings. */
export type Money = number | string | null | undefined

export function toNumber(value: Money): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** Money has two decimal places; floating point does not. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * One cell of the price list.
 *
 * `auto` is the difference between a number somebody chose and a number this
 * file worked out, and the form and the record both say which is which. A price
 * nobody can check the provenance of is a price nobody trusts.
 */
export type DerivedPrice = { value: number | null; auto: boolean }

const typed = (value: number): DerivedPrice => ({ value, auto: false })
const derived = (value: number | null): DerivedPrice => ({ value, auto: true })
const blank: DerivedPrice = { value: null, auto: false }

/** The columns the rules read. Loose enough to accept a row or a half-typed form. */
export type PricingInput = {
  unit_price?: Money
  unit_cost?: Money
  price_showroom?: Money
  price_wholesale?: Money
  piece_price_retail?: Money
  piece_price_showroom?: Money
  piece_price_wholesale?: Money
  pallet_price_retail?: Money
  pallet_price_wholesale?: Money
  piece_cost?: Money
  pallet_cost?: Money
  case_pack?: Money
}

export type ProductPricing = {
  unit: { retail: DerivedPrice; showroom: DerivedPrice; wholesale: DerivedPrice; cost: DerivedPrice }
  piece: {
    retail: DerivedPrice
    showroom: DerivedPrice
    wholesale: DerivedPrice
    cost: DerivedPrice
  }
  pallet: { retail: DerivedPrice; wholesale: DerivedPrice; cost: DerivedPrice }
  /** How many pieces to a unit, once it is a number worth dividing by. */
  casePack: number | null
}

/**
 * Fills in every price a product has, from the few somebody actually typed.
 *
 * Retail drives the two other unit prices; the case pack turns any unit price
 * into a piece price. An override always wins, and overriding showroom changes
 * the piece showroom price with it — the chain is followed, not short-circuited
 * back to retail, because somebody who set a showroom price by hand meant it to
 * be the showroom price at every quantity.
 *
 * Pallet prices derive from nothing. A pallet is priced by negotiation, and
 * inventing a number for it would be worse than leaving the box empty.
 */
export function derivePricing(input: PricingInput): ProductPricing {
  const retail = toNumber(input.unit_price) ?? 0
  const cost = toNumber(input.unit_cost) ?? 0

  const casePackRaw = toNumber(input.case_pack)
  const casePack = casePackRaw !== null && casePackRaw > 0 ? casePackRaw : null

  const override = (value: Money): number | null => toNumber(value)

  const showroomOverride = override(input.price_showroom)
  const wholesaleOverride = override(input.price_wholesale)

  const unit = {
    retail: typed(retail),
    showroom:
      showroomOverride !== null ? typed(showroomOverride) : derived(round2(retail * SHOWROOM_SHARE)),
    wholesale:
      wholesaleOverride !== null
        ? typed(wholesaleOverride)
        : derived(round2(retail * WHOLESALE_SHARE)),
    cost: typed(cost),
  }

  /** A unit price becomes a piece price only when there is a case pack to divide by. */
  const perPiece = (unitPrice: DerivedPrice, overrideValue: Money): DerivedPrice => {
    const own = override(overrideValue)
    if (own !== null) return typed(own)
    if (casePack === null || unitPrice.value === null) return { value: null, auto: true }
    return derived(round2(unitPrice.value / casePack))
  }

  const piece = {
    retail: perPiece(unit.retail, input.piece_price_retail),
    showroom: perPiece(unit.showroom, input.piece_price_showroom),
    wholesale: perPiece(unit.wholesale, input.piece_price_wholesale),
    cost: optional(input.piece_cost),
  }

  const pallet = {
    retail: optional(input.pallet_price_retail),
    wholesale: optional(input.pallet_price_wholesale),
    cost: optional(input.pallet_cost),
  }

  return { unit, piece, pallet, casePack }
}

function optional(value: Money): DerivedPrice {
  const parsed = toNumber(value)
  return parsed === null ? blank : typed(parsed)
}

export type Margin = { amount: number; percent: number | null }

/** What is left after cost, and what share of the price that is. */
export function margin(price: number | null, cost: number | null): Margin {
  const p = price ?? 0
  const amount = round2(p - (cost ?? 0))
  return { amount, percent: p > 0 ? Math.round((amount / p) * 100) : null }
}

/*
 * The two margins the price list is actually run on.
 *
 * Retail is the headline but nothing is sold at it — the showroom and the
 * wholesale prices are where the business happens, so those are the two numbers
 * worth putting on the form. Both are measured against the unit cost, which is
 * the only cost that is always present.
 */
export const showroomMargin = (input: PricingInput): Margin =>
  margin(derivePricing(input).unit.showroom.value, toNumber(input.unit_cost) ?? 0)

export const wholesaleMargin = (input: PricingInput): Margin =>
  margin(derivePricing(input).unit.wholesale.value, toNumber(input.unit_cost) ?? 0)
