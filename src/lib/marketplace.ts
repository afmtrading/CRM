/**
 * What it costs to trade on a marketplace, and what is left.
 *
 * Pure, and deliberately so: this is the arithmetic that decides which channel
 * a pallet goes to, and a number that decides something should be testable
 * without a database in front of it.
 *
 * TWO DIRECTIONS
 *
 * AFM lists inventory on some of these platforms and buys pallets through
 * others, and a few are both — an auction house takes a seller's commission
 * from one side and a buyer's premium from the other. So every rate carries a
 * side, and the two run opposite ways: selling, fees come *off* what the buyer
 * paid; buying, they go *on* what was bid. Same rate card, opposite signs.
 */

export type FeeSide = 'sell' | 'buy'

export interface MarketplaceFee {
  id?: string
  side: FeeSide
  /** A product category, or null for the rate everything else gets. */
  category: string | null
  /** Commission when selling, buyer's premium when buying. */
  percent: number
  /** Listing or lot fee, charged whatever the amount. */
  fixed_fee: number
  /** Card or settlement handling, charged separately from the commission. */
  processing_percent: number
  note?: string | null
}

function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(parsed) ? parsed : 0
}

/** Two decimal places, half up, the way the rest of the money code rounds. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * The rate that applies, most specific first.
 *
 * A rate for the exact category beats the fallback, and the fallback beats
 * nothing. Returning null rather than a zeroed rate is the point: no rate card
 * is not the same as a free marketplace, and a caller that renders 0% for an
 * unpriced channel is lying about a number somebody will act on.
 */
export function resolveFee(
  fees: MarketplaceFee[],
  { category, side }: { category?: string | null; side: FeeSide },
): MarketplaceFee | null {
  const forSide = fees.filter((fee) => fee.side === side)

  if (category) {
    // Case-insensitively, because a category typed into a product and a
    // category picked for a rate are both just text by the time they meet.
    const exact = forSide.find(
      (fee) => fee.category?.trim().toLowerCase() === category.trim().toLowerCase(),
    )
    if (exact) return exact
  }

  return forSide.find((fee) => !fee.category) ?? null
}

export interface FeeBreakdown {
  /** What the buyer paid, or what was bid. */
  gross: number
  commission: number
  processing: number
  fixed: number
  /** Everything the platform takes, however it is described. */
  totalFees: number
  /** Selling: what lands in the account. Buying: what leaves it. */
  net: number
  /** Fees as a share of gross — the number worth comparing across channels. */
  effectiveRate: number
}

/**
 * The rate card applied to an amount.
 *
 * Every component is rounded before being summed rather than the total being
 * rounded once. It is a cent either way, and it is the cent that makes the
 * arithmetic on screen add up when somebody checks it against a statement —
 * a total that does not equal the numbers printed above it reads as a bug
 * whether or not it is one.
 */
export function applyFee(
  gross: number | string,
  fee: MarketplaceFee | null,
  side: FeeSide = 'sell',
): FeeBreakdown {
  const amount = round2(num(gross))

  if (!fee) {
    return {
      gross: amount,
      commission: 0,
      processing: 0,
      fixed: 0,
      totalFees: 0,
      net: amount,
      effectiveRate: 0,
    }
  }

  const commission = round2((amount * num(fee.percent)) / 100)
  const processing = round2((amount * num(fee.processing_percent)) / 100)
  const fixed = round2(num(fee.fixed_fee))
  const totalFees = round2(commission + processing + fixed)

  return {
    gross: amount,
    commission,
    processing,
    fixed,
    totalFees,
    // Selling, the fees come out of what the buyer paid. Buying, they are added
    // to what was bid — the same rate card, read the other way round.
    net: round2(side === 'sell' ? amount - totalFees : amount + totalFees),
    effectiveRate: amount === 0 ? 0 : round2((totalFees / amount) * 100),
  }
}

/** What lands in the account after selling for `gross`. */
export function netProceeds(
  gross: number | string,
  fees: MarketplaceFee[],
  category?: string | null,
): FeeBreakdown {
  return applyFee(gross, resolveFee(fees, { category, side: 'sell' }), 'sell')
}

/** What a lot actually costs after the premium is added to the bid. */
export function landedCost(
  hammer: number | string,
  fees: MarketplaceFee[],
  category?: string | null,
): FeeBreakdown {
  return applyFee(hammer, resolveFee(fees, { category, side: 'buy' }), 'buy')
}

/**
 * The headline rate for a channel, for a list column.
 *
 * The fallback rate where there is one, because that is what most things sell
 * at; the lowest category rate otherwise, since quoting the highest would make
 * a channel look worse than anything actually sold there. Null when the card is
 * empty, so the column can say "not priced" rather than "free".
 */
export function headlineRate(fees: MarketplaceFee[], side: FeeSide = 'sell'): number | null {
  const forSide = fees.filter((fee) => fee.side === side)
  if (forSide.length === 0) return null

  const fallback = forSide.find((fee) => !fee.category)
  const chosen =
    fallback ??
    forSide.reduce((lowest, fee) => (num(fee.percent) < num(lowest.percent) ? fee : lowest))

  return round2(num(chosen.percent) + num(chosen.processing_percent))
}

/** Which directions this marketplace is used in, as a sentence. */
export function directionLabel({
  sells_through,
  sources_from,
}: {
  sells_through: boolean
  sources_from: boolean
}): string {
  if (sells_through && sources_from) return 'Sell and source'
  if (sources_from) return 'Source only'
  return 'Sell only'
}

/**
 * Which sides need a rate card, given how the marketplace is used.
 *
 * A channel you only sell through has no buyer's premium worth recording, and
 * offering the tab would invite somebody to fill it in with a number that never
 * applies to anything.
 */
export function sidesFor({
  sells_through,
  sources_from,
}: {
  sells_through: boolean
  sources_from: boolean
}): FeeSide[] {
  const sides: FeeSide[] = []
  if (sells_through) sides.push('sell')
  if (sources_from) sides.push('buy')
  return sides
}

export const SIDE_LABELS: Record<FeeSide, string> = {
  sell: 'Selling here',
  buy: 'Buying here',
}

export const SIDE_HINTS: Record<FeeSide, string> = {
  sell: 'Taken out of what the buyer pays. What you keep is the gross less these.',
  buy: "Added to what you bid. What the lot costs you is the hammer price plus these.",
}
