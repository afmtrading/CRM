/**
 * A document's history, in words.
 *
 * The table stores what actually changed: a column name, and the two values as
 * text. `company_id` is kept as the uuid it is rather than as the company's
 * name at the time, because a name resolved at write time is a second copy of
 * it, free to drift from the first — the same reasoning the rest of this schema
 * follows for derived values.
 *
 * Which means the reading happens here. Nothing in this module touches the
 * database: the page fetches the names it already needs for its pickers, hands
 * them over as a lookup, and this turns a row into a sentence.
 */

import { formatDay, formatPrice } from '@/lib/format'
import { INVOICE_STATUS_LABELS, SALES_ORDER_STATUS_LABELS } from '@/lib/sales'
import type { InvoiceStatus, SalesOrderStatus } from '@/lib/database.types'

export interface HistoryRow {
  id: string
  seq: number
  action: string
  field: string | null
  old_value: string | null
  new_value: string | null
  changed_by: string | null
  changed_at: string
  source: string
}

/** Names for the ids a document points at, gathered by whoever renders this. */
export interface HistoryLookups {
  users: Map<string, string>
  companies: Map<string, string>
  contacts: Map<string, string>
  locations: Map<string, string>
}

export const EMPTY_LOOKUPS: HistoryLookups = {
  users: new Map(),
  companies: new Map(),
  contacts: new Map(),
  locations: new Map(),
}

/**
 * What to call a column on screen.
 *
 * Anything missing falls through to the humanised column name, so a field added
 * to either document shows up readably before anybody gets here to name it —
 * `shipping_method` reads as "Shipping method" on its own.
 */
const FIELD_LABELS: Record<string, string> = {
  status: 'Status',
  order_date: 'S.O. date',
  issue_date: 'Invoice date',
  due_date: 'Due date',
  company_id: 'Company',
  contact_id: 'Contact',
  ship_to_company_id: 'Ship-to company',
  ship_to_contact_id: 'Ship-to contact',
  owner_id: 'Representative',
  location_id: 'Fulfilling from',
  marketplace_id: 'Sold through',
  payment_terms: 'Payment terms',
  shipping_charge: 'Shipping',
  shipping_address: 'Shipping address',
  shipping_method: 'Shipping method',
  shipping_responsibility: 'Shipping',
  discount_type: 'Discount kind',
  discount_rate: 'Discount',
  deposit_information: 'Deposit information',
  show_discount: 'Discount column on the document',
  amount_paid: 'Paid',
  subtotal: 'Subtotal',
  total: 'Total',
  notes: 'Notes',
  terms: 'Terms',
  currency: 'Currency',
  number: 'Number',
  deleted_at: 'Deleted',
  owner_name: 'Representative name',
  sales_order_id: 'Sales order',
}

export function fieldLabel(field: string | null): string {
  if (!field) return ''
  const known = FIELD_LABELS[field]
  if (known) return known
  const words = field.replace(/_id$/, '').replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Columns whose values are money, and print as money. */
const MONEY = new Set(['shipping_charge', 'subtotal', 'total', 'amount_paid'])
/** Columns holding a uuid, and which lookup answers for each. */
const REFERENCES: Record<string, keyof HistoryLookups> = {
  company_id: 'companies',
  ship_to_company_id: 'companies',
  marketplace_id: 'companies',
  contact_id: 'contacts',
  ship_to_contact_id: 'contacts',
  owner_id: 'users',
  location_id: 'locations',
}

/**
 * One stored value, as somebody should read it.
 *
 * Null is "not set" rather than an empty string, because a history that renders
 * a cleared field as nothing at all reads as though the row is broken.
 */
export function historyValue(
  field: string | null,
  value: string | null,
  currency: string,
  lookups: HistoryLookups = EMPTY_LOOKUPS,
): string {
  if (value === null || value === '') return 'not set'
  if (!field) return value

  const reference = REFERENCES[field]
  if (reference) {
    // Falls back to "a record since removed" rather than printing a uuid: the
    // id is true and unreadable, and the history is for a person.
    return lookups[reference].get(value) ?? 'a record since removed'
  }

  if (field === 'status') {
    return (
      SALES_ORDER_STATUS_LABELS[value as SalesOrderStatus] ??
      INVOICE_STATUS_LABELS[value as InvoiceStatus] ??
      value
    )
  }

  if (MONEY.has(field)) {
    const amount = Number(value)
    return Number.isFinite(amount) ? formatPrice(amount, currency) : value
  }

  if (field === 'discount_rate') {
    const amount = Number(value)
    return Number.isFinite(amount) ? String(amount) : value
  }

  if (field === 'discount_type') return value === 'percent' ? '%' : '$'

  if (value === 'true') return 'shown'
  if (value === 'false') return 'hidden'

  // A date column, which arrives as YYYY-MM-DD and should not read as one.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDay(value)

  // Long free text is a paragraph, not a line. Say it changed and stop.
  if (value.length > 60) return `${value.slice(0, 57)}…`

  return value
}

export interface HistoryEntry {
  id: string
  /** "Created", or "Payment terms". */
  label: string
  /** Null on a created row — there is nothing it changed from. */
  from: string | null
  to: string | null
  who: string
  when: string
  /** True for the row standing in for a document that predates this table. */
  assumed: boolean
}

/**
 * The rows a card should draw, newest first.
 *
 * Sorted by `seq` rather than by `changed_at`: two changes saved together share
 * a timestamp, and ordering by the clock would put one save's fields in an
 * arbitrary sequence. That is what the column is for.
 */
export function historyEntries(
  rows: HistoryRow[],
  currency: string,
  lookups: HistoryLookups = EMPTY_LOOKUPS,
): HistoryEntry[] {
  return [...rows]
    .sort((a, b) => b.seq - a.seq)
    .map((row) => ({
      id: row.id,
      label: row.action === 'created' ? 'Created' : fieldLabel(row.field),
      from: row.action === 'created' ? null : historyValue(row.field, row.old_value, currency, lookups),
      to: row.action === 'created' ? null : historyValue(row.field, row.new_value, currency, lookups),
      who: row.changed_by ? (lookups.users.get(row.changed_by) ?? 'Someone since removed') : 'Unknown',
      when: row.changed_at,
      /*
       * A backfilled row is not an observed change. It asserts only that the
       * document existed by then, and saying so is the difference between a
       * history and a guess.
       */
      assumed: row.source === 'backfill',
    }))
}
