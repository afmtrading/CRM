import { describe, expect, it } from 'vitest'

import {
  formatDelta,
  normaliseEntries,
  placeKey,
  summarise,
  summariseEntries,
} from '../src/lib/stock'

describe('summarise', () => {
  it('adds the places up', () => {
    const summary = summarise([
      { quantity: 480, reserved: 30 },
      { quantity: 20, reserved: 0 },
    ])

    expect(summary.onHand).toBe(500)
    expect(summary.reserved).toBe(30)
    expect(summary.available).toBe(470)
  })

  it('takes what open deals have promised out of what is available', () => {
    const summary = summarise([{ quantity: 500, reserved: 30 }], 200)
    expect(summary.committed).toBe(200)
    expect(summary.available).toBe(270)
  })

  it('goes negative rather than pretending', () => {
    // Clamping this at zero is how a warehouse finds out it has oversold by
    // disappointing somebody rather than by reading a screen.
    expect(summarise([{ quantity: 100, reserved: 0 }], 900).available).toBe(-800)
  })

  it('reads the strings Postgres sends back', () => {
    // numeric(14,3) arrives over PostgREST as a string.
    const summary = summarise([{ quantity: '480.500', reserved: '0.500' } as never])
    expect(summary.onHand).toBe(480.5)
    expect(summary.available).toBe(480)
  })

  it('has nothing to add up before anybody has counted', () => {
    expect(summarise([])).toEqual({ onHand: 0, committed: 0, reserved: 0, available: 0 })
  })
})

describe('summariseEntries', () => {
  it('totals rows that are still being typed, half-filled ones included', () => {
    const summary = summariseEntries(
      [
        { location_id: 'a', bin_id: '', quantity: '12' },
        { location_id: 'b', bin_id: '', quantity: '' },
        { location_id: 'c', bin_id: '', quantity: '8' },
      ],
      5,
      2,
    )

    expect(summary.onHand).toBe(20)
    expect(summary.available).toBe(13)
  })
})

describe('placeKey', () => {
  it('makes "no bin" one place rather than a new one every time', () => {
    expect(placeKey('loc', null)).toBe(placeKey('loc', ''))
    expect(placeKey('loc', undefined)).toBe(placeKey('loc', ''))
  })

  it('keeps a bin distinct from the shelf it stands on', () => {
    expect(placeKey('loc', 'bin')).not.toBe(placeKey('loc', ''))
  })
})

describe('normaliseEntries', () => {
  it('drops rows where nobody picked a location', () => {
    const entries = normaliseEntries([
      { location_id: '', bin_id: '', quantity: '50' },
      { location_id: 'a', bin_id: '', quantity: '10' },
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0].location_id).toBe('a')
  })

  it('folds the same place together rather than writing it twice', () => {
    // Somebody who adds the same warehouse twice means the total. Two writes
    // for one place would also leave the history claiming a movement that
    // never happened.
    const entries = normaliseEntries([
      { location_id: 'a', bin_id: '', quantity: '10' },
      { location_id: 'a', bin_id: '', quantity: '5' },
    ])

    expect(entries).toEqual([{ location_id: 'a', bin_id: '', quantity: '15' }])
  })

  it('does not fold two different bins in one warehouse', () => {
    const entries = normaliseEntries([
      { location_id: 'a', bin_id: 'rack', quantity: '10' },
      { location_id: 'a', bin_id: 'floor', quantity: '5' },
    ])

    expect(entries).toHaveLength(2)
  })

  it('reads a blank quantity as none rather than dropping the row', () => {
    // The row still names a place, and a place that holds zero is a fact worth
    // recording — it is how "we used to stock this here" gets written down.
    expect(normaliseEntries([{ location_id: 'a', bin_id: '', quantity: '' }])).toEqual([
      { location_id: 'a', bin_id: '', quantity: '0' },
    ])
  })
})

describe('formatDelta', () => {
  it('reads as a movement', () => {
    expect(formatDelta(40)).toBe('+40')
    expect(formatDelta(-12)).toBe('-12')
    expect(formatDelta(0)).toBe('0')
  })
})
