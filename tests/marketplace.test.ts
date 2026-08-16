import { describe, expect, it } from 'vitest'

import {
  applyFee,
  directionLabel,
  headlineRate,
  landedCost,
  netProceeds,
  resolveFee,
  sidesFor,
  type MarketplaceFee,
} from '@/lib/marketplace'

const fee = (over: Partial<MarketplaceFee> = {}): MarketplaceFee => ({
  side: 'sell',
  category: null,
  percent: 0,
  fixed_fee: 0,
  processing_percent: 0,
  ...over,
})

describe('resolveFee', () => {
  const fees = [
    fee({ category: null, percent: 12 }),
    fee({ category: 'Medical', percent: 8 }),
    fee({ side: 'buy', category: null, percent: 15 }),
    fee({ side: 'buy', category: 'Medical', percent: 18 }),
  ]

  it('prefers a rate for the exact category', () => {
    expect(resolveFee(fees, { category: 'Medical', side: 'sell' })?.percent).toBe(8)
  })

  it('falls back to the row with no category', () => {
    expect(resolveFee(fees, { category: 'Apparel', side: 'sell' })?.percent).toBe(12)
  })

  it('uses the fallback when no category was given at all', () => {
    expect(resolveFee(fees, { side: 'sell' })?.percent).toBe(12)
  })

  // A category typed on a product and a category picked for a rate are both
  // just text by the time they meet.
  it('matches a category whatever its case or padding', () => {
    expect(resolveFee(fees, { category: '  medical ', side: 'sell' })?.percent).toBe(8)
  })

  it('keeps the two sides apart', () => {
    expect(resolveFee(fees, { category: 'Medical', side: 'buy' })?.percent).toBe(18)
  })

  /*
   * The important one. No rate card is not the same as a free marketplace, and
   * a caller that renders 0% for an unpriced channel is lying about a number
   * somebody is about to act on.
   */
  it('returns nothing rather than a zeroed rate when the card is empty', () => {
    expect(resolveFee([], { category: 'Medical', side: 'sell' })).toBeNull()
    expect(resolveFee(fees, { category: 'Medical', side: 'buy' })).not.toBeNull()
    expect(resolveFee([fee({ side: 'sell' })], { side: 'buy' })).toBeNull()
  })
})

describe('applyFee', () => {
  it('takes fees off the gross when selling', () => {
    const result = applyFee(1000, fee({ percent: 12, processing_percent: 2.9, fixed_fee: 0.3 }))

    expect(result.commission).toBe(120)
    expect(result.processing).toBe(29)
    expect(result.fixed).toBe(0.3)
    expect(result.totalFees).toBe(149.3)
    expect(result.net).toBe(850.7)
  })

  it('adds them to the bid when buying', () => {
    const result = applyFee(1000, fee({ side: 'buy', percent: 18, fixed_fee: 25 }), 'buy')

    expect(result.totalFees).toBe(205)
    expect(result.net).toBe(1205)
  })

  // The components are printed above the total on the screen, so they have to
  // add up to it. Rounding the total separately is how they stop doing that.
  it('sums components that were each rounded, so the screen adds up', () => {
    const result = applyFee(333.33, fee({ percent: 12.5, processing_percent: 2.9 }))

    expect(result.commission).toBe(41.67)
    expect(result.processing).toBe(9.67)
    expect(result.totalFees).toBe(51.34)
    expect(result.commission + result.processing + result.fixed).toBeCloseTo(result.totalFees, 10)
    expect(result.net).toBe(281.99)
  })

  it('leaves the amount alone when there is no rate', () => {
    const result = applyFee(500, null)

    expect(result.totalFees).toBe(0)
    expect(result.net).toBe(500)
    expect(result.effectiveRate).toBe(0)
  })

  it('reports the effective rate, which is what compares channels', () => {
    expect(applyFee(1000, fee({ percent: 10, fixed_fee: 50 })).effectiveRate).toBe(15)
  })

  // A fixed fee on a zero amount is a real state — a listing that never sold —
  // and dividing by it would put Infinity on the screen.
  it('does not divide by a gross of zero', () => {
    const result = applyFee(0, fee({ percent: 10, fixed_fee: 5 }))

    expect(result.effectiveRate).toBe(0)
    expect(result.net).toBe(-5)
  })

  it('reads a string amount, as a form field gives it', () => {
    expect(applyFee('1000', fee({ percent: 10 })).net).toBe(900)
  })
})

describe('netProceeds and landedCost', () => {
  const fees = [
    fee({ category: null, percent: 12, processing_percent: 2.9 }),
    fee({ category: 'Medical', percent: 8 }),
    fee({ side: 'buy', category: null, percent: 15, fixed_fee: 40 }),
  ]

  it('prices a sale at the category rate', () => {
    expect(netProceeds(2000, fees, 'Medical').net).toBe(1840)
  })

  it('prices a sale with no category at the fallback', () => {
    expect(netProceeds(2000, fees, 'Furniture').net).toBe(1702)
  })

  it('prices a purchase the other way round', () => {
    const result = landedCost(2000, fees)

    expect(result.totalFees).toBe(340)
    expect(result.net).toBe(2340)
  })

  /*
   * The same platform, both directions, and the two must not borrow each
   * other's numbers: an auction house's 15% buyer's premium is not its selling
   * commission.
   */
  it('does not let one side read the other side rates', () => {
    expect(netProceeds(1000, [fee({ side: 'buy', percent: 15 })]).net).toBe(1000)
    expect(landedCost(1000, [fee({ side: 'sell', percent: 12 })]).net).toBe(1000)
  })
})

describe('headlineRate', () => {
  it('quotes the fallback rate, since that is what most things sell at', () => {
    const rate = headlineRate([
      fee({ category: null, percent: 12, processing_percent: 3 }),
      fee({ category: 'Medical', percent: 8 }),
    ])

    expect(rate).toBe(15)
  })

  // Quoting the highest would make a channel look worse than anything actually
  // sold there.
  it('quotes the lowest category rate when there is no fallback', () => {
    const rate = headlineRate([
      fee({ category: 'Medical', percent: 8 }),
      fee({ category: 'Apparel', percent: 14 }),
    ])

    expect(rate).toBe(8)
  })

  it('says nothing rather than zero for an unpriced channel', () => {
    expect(headlineRate([])).toBeNull()
    expect(headlineRate([fee({ side: 'buy', percent: 15 })], 'sell')).toBeNull()
  })
})

describe('how a marketplace is used', () => {
  it('names both directions', () => {
    expect(directionLabel({ sells_through: true, sources_from: true })).toBe('Sell and source')
    expect(directionLabel({ sells_through: true, sources_from: false })).toBe('Sell only')
    expect(directionLabel({ sells_through: false, sources_from: true })).toBe('Source only')
  })

  // A channel you only sell through has no buyer's premium worth recording, and
  // offering the tab invites a number that never applies to anything.
  it('only offers a rate card for the directions in use', () => {
    expect(sidesFor({ sells_through: true, sources_from: false })).toEqual(['sell'])
    expect(sidesFor({ sells_through: false, sources_from: true })).toEqual(['buy'])
    expect(sidesFor({ sells_through: true, sources_from: true })).toEqual(['sell', 'buy'])
  })
})
