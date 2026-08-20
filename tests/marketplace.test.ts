import { describe, expect, it } from 'vitest'

import {
  directionLabel,
  isMarketplaceSection,
  marketplaceSections,
  parseYesNo,
  yesNo,
} from '@/lib/marketplace'

describe('directionLabel', () => {
  it('names both directions', () => {
    expect(directionLabel({ sells_through: true, sources_from: true })).toBe('Sell and source')
    expect(directionLabel({ sells_through: true, sources_from: false })).toBe('Sell only')
    expect(directionLabel({ sells_through: false, sources_from: true })).toBe('Source only')
  })
})

/*
 * The whole point of these two is the third state. A platform whose buyer's
 * premium nobody has looked up is not a platform without one, and collapsing
 * "not recorded" into "No" puts a fact on screen that nobody established.
 */
describe('yes, no, or nothing said', () => {
  it('renders the two answers', () => {
    expect(yesNo(true)).toBe('Yes')
    expect(yesNo(false)).toBe('No')
  })

  it('says nothing when nothing was recorded', () => {
    expect(yesNo(null)).toBeNull()
    expect(yesNo(undefined)).toBeNull()
  })

  it('reads a blank form field as not recorded rather than as No', () => {
    expect(parseYesNo('')).toBeNull()
    expect(parseYesNo(null)).toBeNull()
    expect(parseYesNo('   ')).toBeNull()
  })

  it('reads the two answers back', () => {
    expect(parseYesNo('true')).toBe(true)
    expect(parseYesNo('false')).toBe(false)
  })

  // A checkbox posts "on"; a select posts "true". Both mean yes.
  it('accepts either spelling of yes', () => {
    expect(parseYesNo('on')).toBe(true)
    expect(parseYesNo('yes')).toBe(true)
  })

  it('round-trips', () => {
    for (const value of [true, false, null]) {
      expect(parseYesNo(value === null ? '' : String(value))).toBe(value)
    }
  })
})

describe('which fields a marketplace form is carrying', () => {
  it('carries everything when it names nothing', () => {
    expect(marketplaceSections(null)).toEqual({ detail: true, fees: true, account: true })
    expect(marketplaceSections('')).toEqual({ detail: true, fees: true, account: true })
    expect(marketplaceSections('  ')).toEqual({ detail: true, fees: true, account: true })
  })

  it('carries only the group it names', () => {
    expect(marketplaceSections('detail')).toEqual({ detail: true, fees: false, account: false })
    expect(marketplaceSections('fees')).toEqual({ detail: false, fees: true, account: false })
    expect(marketplaceSections('account')).toEqual({ detail: false, fees: false, account: true })
  })

  /*
   * The important one. A form claiming a group nobody defined must write no
   * fields at all — writing every field would empty the two cards it never
   * showed, which is the exact failure this function exists to prevent.
   */
  it('carries nothing when it names something unrecognised', () => {
    expect(marketplaceSections('payouts')).toEqual({
      detail: false,
      fees: false,
      account: false,
    })
  })

  it('knows the three names', () => {
    expect(isMarketplaceSection('detail')).toBe(true)
    expect(isMarketplaceSection('fees')).toBe(true)
    expect(isMarketplaceSection('account')).toBe(true)
    expect(isMarketplaceSection('payouts')).toBe(false)
  })
})
