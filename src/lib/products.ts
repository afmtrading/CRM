/**
 * The product vocabulary, and the arithmetic behind a price list.
 *
 * Pure by design — no server imports, nothing from Supabase — so the pricing
 * rules can be unit tested directly and so the same function runs on the form
 * as the user types and on the record when it is read back. If those two ever
 * disagreed, the number somebody saw while typing would not be the number that
 * got saved.
 */

import type { ProductCondition, ProductStatus, ProductType } from '@/lib/database.types'

export type { ProductCondition, ProductStatus, ProductType }

// -----------------------------------------------------------------------------
// What kind of thing, in what state, and where in its life
// -----------------------------------------------------------------------------

export const PRODUCT_TYPES: { value: ProductType; label: string }[] = [
  { value: 'item', label: 'Item' },
  { value: 'case', label: 'Case' },
  { value: 'pallet', label: 'Pallet' },
  { value: 'kit', label: 'Kit' },
  { value: 'bin', label: 'Bin' },
]

export const PRODUCT_CONDITIONS: { value: ProductCondition; label: string; tone: string }[] = [
  { value: 'new', label: 'New', tone: 'bg-emerald-100 text-emerald-700' },
  { value: 'open_box', label: 'Open Box', tone: 'bg-blue-100 text-blue-700' },
  { value: 'damaged', label: 'Damaged', tone: 'bg-red-100 text-red-700' },
  { value: 'refurbished', label: 'Refurbished', tone: 'bg-violet-100 text-violet-700' },
  { value: 'expired', label: 'Expired', tone: 'bg-amber-100 text-amber-800' },
]

/**
 * Only 'active' is offered on new deals. That is not a convention the UI
 * enforces — the database derives products.active from this column, so a
 * quarantined pallet leaves the picker whether or not anyone remembers to
 * untick anything.
 */
export const PRODUCT_STATUSES: { value: ProductStatus; label: string; tone: string; hint: string }[] =
  [
    {
      value: 'active',
      label: 'Active',
      tone: 'bg-emerald-100 text-emerald-700',
      hint: 'Offered on new deals',
    },
    {
      value: 'inactive',
      label: 'Inactive',
      tone: 'bg-slate-100 text-slate-600',
      hint: 'Kept, but not on offer',
    },
    {
      value: 'discontinued',
      label: 'Discontinued',
      tone: 'bg-slate-100 text-slate-600',
      hint: 'Not coming back',
    },
    {
      value: 'quarantined',
      label: 'Quarantined',
      tone: 'bg-amber-100 text-amber-800',
      hint: 'Held — do not sell',
    },
    { value: 'sold', label: 'Sold', tone: 'bg-blue-100 text-blue-700', hint: 'All of it is gone' },
  ]

function labelFrom<T extends { value: string; label: string }>(
  list: T[],
  value: string | null | undefined,
): string | null {
  if (!value) return null
  return list.find((entry) => entry.value === value)?.label ?? value
}

export const productTypeLabel = (value: string | null | undefined) =>
  labelFrom(PRODUCT_TYPES, value)

export const productConditionLabel = (value: string | null | undefined) =>
  labelFrom(PRODUCT_CONDITIONS, value)

export const productStatusLabel = (value: string | null | undefined) =>
  labelFrom(PRODUCT_STATUSES, value) ?? 'Active'

export function productStatusTone(value: string | null | undefined): string {
  return (
    PRODUCT_STATUSES.find((entry) => entry.value === value)?.tone ?? 'bg-slate-100 text-slate-600'
  )
}

export function productConditionTone(value: string | null | undefined): string {
  return (
    PRODUCT_CONDITIONS.find((entry) => entry.value === value)?.tone ?? 'bg-slate-100 text-slate-600'
  )
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

/**
 * Margin on the unit, which is the only quantity that has both a price and a
 * cost that are always present.
 */
export function unitMargin(input: PricingInput): { amount: number; percent: number | null } {
  const price = toNumber(input.unit_price) ?? 0
  const cost = toNumber(input.unit_cost) ?? 0
  const amount = round2(price - cost)
  return { amount, percent: price > 0 ? Math.round((amount / price) * 100) : null }
}
