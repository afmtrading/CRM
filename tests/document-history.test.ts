import { describe, expect, it } from 'vitest'

import {
  EMPTY_LOOKUPS,
  fieldLabel,
  historyEntries,
  historyValue,
} from '@/lib/document-history'
import type { HistoryLookups, HistoryRow } from '@/lib/document-history'

/**
 * The trail stores column names and raw values; a person reads names and money.
 * Everything here is that translation, and the cases that would otherwise put a
 * uuid in front of somebody.
 */

const lookups: HistoryLookups = {
  users: new Map([['u1', 'Alain'], ['u2', 'Paulina']]),
  companies: new Map([['c1', 'ACME']]),
  contacts: new Map([['p1', 'Ruben Diaz']]),
  locations: new Map([['l1', 'Centerville']]),
}

function row(over: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: 'h1',
    seq: 1,
    action: 'updated',
    field: 'payment_terms',
    old_value: null,
    new_value: 'Net 30',
    changed_by: 'u1',
    changed_at: '2026-08-22T10:00:00Z',
    source: 'trigger',
    ...over,
  }
}

describe('fieldLabel', () => {
  it('names the columns somebody actually sees', () => {
    expect(fieldLabel('payment_terms')).toBe('Payment terms')
    expect(fieldLabel('shipping_responsibility')).toBe('Shipping')
    expect(fieldLabel('owner_id')).toBe('Representative')
    expect(fieldLabel('order_date')).toBe('S.O. date')
  })

  /*
   * A column added to either document has to read sensibly before anybody
   * comes back here to name it. The alternative is a history that says
   * "delivery_window_id" at somebody.
   */
  it('humanises a column nobody has named yet', () => {
    expect(fieldLabel('delivery_window')).toBe('Delivery window')
    expect(fieldLabel('carrier_account_id')).toBe('Carrier account')
  })

  it('says nothing for a created row', () => {
    expect(fieldLabel(null)).toBe('')
  })
})

describe('historyValue', () => {
  it('resolves an id to the name it stands for', () => {
    expect(historyValue('company_id', 'c1', 'USD', lookups)).toBe('ACME')
    expect(historyValue('contact_id', 'p1', 'USD', lookups)).toBe('Ruben Diaz')
    expect(historyValue('owner_id', 'u1', 'USD', lookups)).toBe('Alain')
    expect(historyValue('location_id', 'l1', 'USD', lookups)).toBe('Centerville')
  })

  /* The id is true and unreadable. Never put one in front of somebody. */
  it('says so rather than printing a uuid it cannot resolve', () => {
    expect(historyValue('company_id', 'gone', 'USD', lookups)).toBe('a record since removed')
  })

  it('prints money as money', () => {
    expect(historyValue('shipping_charge', '2000', 'USD', lookups)).toBe('$2,000.00')
    expect(historyValue('total', '2600.5', 'USD', lookups)).toBe('$2,600.50')
  })

  it('prints a status as its label rather than its enum member', () => {
    // `fulfilled` reads as Invoiced everywhere else, and a history is not the
    // place somebody meets the stored value for the first time.
    expect(historyValue('status', 'fulfilled', 'USD', lookups)).toBe('Invoiced')
    expect(historyValue('status', 'draft', 'USD', lookups)).toBe('Draft')
  })

  it('prints a discount kind as the symbol the form offers', () => {
    expect(historyValue('discount_type', 'percent', 'USD', lookups)).toBe('%')
    expect(historyValue('discount_type', 'fixed', 'USD', lookups)).toBe('$')
  })

  it('prints booleans as what they did', () => {
    expect(historyValue('show_discount', 'true', 'USD', lookups)).toBe('shown')
    expect(historyValue('show_discount', 'false', 'USD', lookups)).toBe('hidden')
  })

  it('prints a date as a date', () => {
    expect(historyValue('order_date', '2026-08-22', 'USD', lookups)).toBe('Aug 22, 2026')
  })

  /* A cleared field rendered as nothing at all reads as a broken row. */
  it('calls an empty value "not set"', () => {
    expect(historyValue('payment_terms', null, 'USD', lookups)).toBe('not set')
    expect(historyValue('payment_terms', '', 'USD', lookups)).toBe('not set')
  })

  it('truncates a paragraph rather than pasting it into a sidebar', () => {
    const long = 'x'.repeat(200)
    const shown = historyValue('notes', long, 'USD', lookups)
    expect(shown).toHaveLength(58)
    expect(shown.endsWith('…')).toBe(true)
  })

  it('works with no lookups at all', () => {
    expect(historyValue('payment_terms', 'COD', 'USD', EMPTY_LOOKUPS)).toBe('COD')
  })
})

describe('historyEntries', () => {
  /*
   * By seq, not by changed_at. Two fields saved together share a timestamp, so
   * sorting by the clock puts one save's changes in an arbitrary order.
   */
  it('orders by seq, newest first', () => {
    const same = '2026-08-22T10:00:00Z'
    const entries = historyEntries(
      [
        row({ id: 'a', seq: 1, field: 'payment_terms', changed_at: same }),
        row({ id: 'c', seq: 3, field: 'notes', changed_at: same }),
        row({ id: 'b', seq: 2, field: 'currency', changed_at: same }),
      ],
      'USD',
      lookups,
    )
    expect(entries.map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
  })

  it('reads a change as from and to', () => {
    const [entry] = historyEntries(
      [row({ old_value: 'COD', new_value: 'Net 30' })],
      'USD',
      lookups,
    )
    expect(entry.label).toBe('Payment terms')
    expect(entry.from).toBe('COD')
    expect(entry.to).toBe('Net 30')
    expect(entry.who).toBe('Alain')
  })

  it('a created row has no from and no to', () => {
    const [entry] = historyEntries(
      [row({ action: 'created', field: null, old_value: null, new_value: null })],
      'USD',
      lookups,
    )
    expect(entry.label).toBe('Created')
    expect(entry.from).toBeNull()
    expect(entry.to).toBeNull()
  })

  /*
   * A backfilled row asserts only that the document existed by then. Saying so
   * is the difference between a history and a guess.
   */
  it('marks a backfilled row as not an observed change', () => {
    const [entry] = historyEntries([row({ source: 'backfill' })], 'USD', lookups)
    expect(entry.assumed).toBe(true)
    expect(historyEntries([row()], 'USD', lookups)[0].assumed).toBe(false)
  })

  it('names somebody who has since been removed rather than an id', () => {
    const [entry] = historyEntries([row({ changed_by: 'gone' })], 'USD', lookups)
    expect(entry.who).toBe('Someone since removed')
  })

  it('handles a change nobody is attributed with', () => {
    const [entry] = historyEntries([row({ changed_by: null })], 'USD', lookups)
    expect(entry.who).toBe('Unknown')
  })

  it('does not mutate what it was handed', () => {
    const rows = [row({ seq: 1 }), row({ id: 'h2', seq: 2 })]
    historyEntries(rows, 'USD', lookups)
    expect(rows.map((one) => one.seq)).toEqual([1, 2])
  })
})
