/**
 * Which columns a list shows, and in what order.
 *
 * Three lists — contacts, companies, products — each with more fields worth
 * showing than fit across a screen. The set that suits a buyer chasing regions
 * is not the set that suits somebody pricing a pallet, and picking one for
 * everybody means picking wrong for most people.
 *
 * Pure, so the rules can be tested without a database and so the picker in the
 * browser and the table on the server agree about what a saved list means. What
 * a column *looks* like is not here: each page renders its own cells, because
 * the lookups a cell needs — owner names, option colours, stock counts — live
 * on the page that fetched them, and threading them through a shared renderer
 * would be a worse coupling than the small amount of repetition it saves.
 */

import type { CustomFieldDefinitionRow } from '@/lib/database.types'

export type TableEntity = 'contact' | 'company' | 'product' | 'marketplace'

export interface TableColumn {
  key: string
  label: string
  /**
   * Always present, always first, never removable.
   *
   * Exactly one per list, and it is the one carrying the link to the record. A
   * table you cannot click out of is a dead end, and somebody who has hidden
   * every recognisable column has no way back to the picker's row order to
   * work out what they are looking at.
   */
  locked?: boolean
  align?: 'left' | 'center' | 'right'
}

/* -------------------------------------------------------------------------- */
/* The catalogues                                                             */
/* -------------------------------------------------------------------------- */

const CONTACT_COLUMNS: TableColumn[] = [
  { key: 'name', label: 'Name', locked: true },
  { key: 'company', label: 'Company' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'owner', label: 'Owner' },
  { key: 'priority', label: 'Priority' },
  { key: 'role_type', label: 'Role type' },
  { key: 'credibility', label: 'Credibility' },
  { key: 'lifecycle_stage', label: 'Lifecycle stage' },
  { key: 'tags', label: 'Tags' },
  { key: 'lead_score', label: 'Lead score', align: 'right' },
  { key: 'source', label: 'Source' },
  { key: 'job_title', label: 'Job title' },
  /* The company's, not the person's — see the note on the contacts page. */
  { key: 'region', label: 'Region' },
  { key: 'created_at', label: 'Created' },
]

const COMPANY_COLUMNS: TableColumn[] = [
  { key: 'name', label: 'Name', locked: true },
  { key: 'priority', label: 'Priority' },
  { key: 'customer_type', label: 'Company type' },
  { key: 'specialty_market', label: 'Merchandise' },
  { key: 'stock_type', label: 'Stock type' },
  { key: 'owner', label: 'Owner' },
  { key: 'contacts', label: 'Contacts', align: 'right' },
  { key: 'tags', label: 'Tags' },
  { key: 'size', label: 'Size' },
  { key: 'region', label: 'Region' },
  { key: 'based_in', label: 'Base Country' },
  { key: 'sells_in', label: 'Sells To' },
  { key: 'domain', label: 'Website' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'created_at', label: 'Created' },
]

const PRODUCT_COLUMNS: TableColumn[] = [
  { key: 'name', label: 'Product', locked: true },
  { key: 'product_type', label: 'Product type' },
  { key: 'status', label: 'Status' },
  { key: 'available', label: 'Available', align: 'center' },
  { key: 'location', label: 'Location', align: 'center' },
  { key: 'price_showroom', label: 'Showroom $', align: 'center' },
  { key: 'price_wholesale', label: 'Wholesale $', align: 'center' },
  { key: 'price_retail', label: 'Retail $', align: 'center' },
  { key: 'unit_cost', label: 'Cost $', align: 'center' },
  { key: 'on_hand', label: 'On hand', align: 'center' },
  { key: 'committed', label: 'Committed', align: 'center' },
  { key: 'brand', label: 'Brand' },
  { key: 'sku', label: 'SKU' },
  { key: 'category', label: 'Category' },
  { key: 'product_condition', label: 'Condition' },
  { key: 'priority', label: 'Priority' },
  { key: 'tags', label: 'Tags' },
  { key: 'case_pack', label: 'Case pack', align: 'center' },
  { key: 'created_at', label: 'Created' },
]

/*
 * A marketplace is a company, so its list can show anything a company can. What
 * is added is what only a marketplace has — the rate, the payout terms, which
 * directions it trades in — and those are what it leads with, because they are
 * the questions the section exists to answer.
 */
const MARKETPLACE_COLUMNS: TableColumn[] = [
  { key: 'name', label: 'Marketplace', locked: true },
  { key: 'marketplace_type', label: 'Type' },
  { key: 'selling_cost', label: 'Selling cost' },
  { key: 'audience', label: 'Audience' },
  { key: 'inventory_type', label: 'Inventory' },
  { key: 'fulfilment', label: 'Fulfilment' },
  { key: 'payment', label: 'Payment' },
  { key: 'buyers_premium', label: "Buyer's premium" },
  { key: 'priority', label: 'Priority' },
  /* The company's own column, not a copy — see the note in 20260246000000. */
  { key: 'sells_in', label: 'Sells To' },
  { key: 'direction', label: 'Used for' },
  { key: 'settlement_terms', label: 'Payout' },
  { key: 'account_status', label: 'Account' },
  { key: 'store_name', label: 'Store' },
  { key: 'reserve_percent', label: 'Reserve', align: 'right' },
  { key: 'minimum_lot_value', label: 'Minimum lot', align: 'right' },
  { key: 'payout_currency', label: 'Settles in' },
  { key: 'owner', label: 'Owner' },
  { key: 'contacts', label: 'Contacts', align: 'right' },
  { key: 'based_in', label: 'Base Country' },
  { key: 'specialty_market', label: 'Merchandise' },
  { key: 'domain', label: 'Website' },
  { key: 'opened_on', label: 'Opened' },
  /*
   * The company's tags, not a set of its own. A marketplace is a company, so
   * the word an organization put on the record is the same word on both
   * screens — offering a separate vocabulary here would be two answers to one
   * question.
   */
  { key: 'tags', label: 'Tags' },
]

/** What each list shows before anybody has said otherwise — today's columns. */
const DEFAULTS: Record<TableEntity, string[]> = {
  contact: ['name', 'company', 'owner', 'priority', 'role_type', 'credibility', 'region'],
  company: ['name', 'priority', 'customer_type', 'specialty_market', 'owner', 'contacts', 'region'],
  product: [
    'name',
    'product_type',
    'status',
    'available',
    'location',
    'price_showroom',
    'price_wholesale',
  ],
  marketplace: [
    'name',
    'marketplace_type',
    'selling_cost',
    'audience',
    'inventory_type',
    'priority',
    'sells_in',
  ],
}

function baseColumns(entity: TableEntity): TableColumn[] {
  switch (entity) {
    case 'company':
      return COMPANY_COLUMNS
    case 'product':
      return PRODUCT_COLUMNS
    case 'marketplace':
      return MARKETPLACE_COLUMNS
    default:
      return CONTACT_COLUMNS
  }
}

/**
 * Everything this list could show, custom fields included.
 *
 * Custom fields come last and are off by default: an organization that has
 * defined twenty of them should not find twenty new columns one morning.
 */
export function columnCatalogue(
  entity: TableEntity,
  customFields: CustomFieldDefinitionRow[] = [],
): TableColumn[] {
  /*
   * A marketplace is a company, so it inherits the company's custom fields.
   * There is no 'marketplace' entity_type to define one against, and inventing
   * one would mean a custom field that exists on some companies and not others
   * depending on a profile row.
   */
  const owner = entity === 'marketplace' ? 'company' : entity

  const custom = customFields
    .filter((definition) => definition.entity_type === owner)
    .map((definition) => ({
      key: `custom_fields.${definition.key}`,
      label: definition.label,
    }))

  return [...baseColumns(entity), ...custom]
}

export function defaultColumns(entity: TableEntity): string[] {
  return [...DEFAULTS[entity]]
}

/**
 * The saved choice, made safe to render.
 *
 * Four things happen here, and each is a bug that would otherwise reach a page:
 *
 *   * nothing saved means the defaults, not an empty table;
 *   * a key that is no longer in the catalogue is dropped, because a custom
 *     field somebody deleted would otherwise render a column of blanks forever;
 *   * the locked column is put back if it is missing, and put first — a saved
 *     list from an older catalogue may predate it;
 *   * duplicates collapse, so a mangled preference cannot render one column
 *     twice and make the header row disagree with the body.
 *
 * Order is the saved order. That is the whole point of the feature, so it is
 * honoured exactly rather than re-sorted into catalogue order.
 */
export function resolveColumns(
  entity: TableEntity,
  saved: string[] | null | undefined,
  catalogue: TableColumn[] = columnCatalogue(entity),
): TableColumn[] {
  const byKey = new Map(catalogue.map((column) => [column.key, column]))
  const locked = catalogue.filter((column) => column.locked)

  const wanted = saved && saved.length > 0 ? saved : defaultColumns(entity)

  const seen = new Set<string>()
  const resolved: TableColumn[] = []

  for (const column of locked) {
    seen.add(column.key)
    resolved.push(column)
  }

  for (const key of wanted) {
    if (seen.has(key)) continue
    const column = byKey.get(key)
    if (!column) continue
    seen.add(key)
    resolved.push(column)
  }

  return resolved
}

/**
 * What to store for a choice made in the picker.
 *
 * Symmetrical with resolveColumns on purpose: what goes in comes back out. The
 * locked column is stored too even though it is implied — a stored list that
 * reads the same as the rendered one is one somebody can debug.
 */
export function normaliseSelection(
  entity: TableEntity,
  selected: string[],
  catalogue: TableColumn[] = columnCatalogue(entity),
): string[] {
  return resolveColumns(entity, selected, catalogue).map((column) => column.key)
}

/** Moves a column, for the picker's drag and its keyboard equivalent. */
export function moveColumn<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items
  }

  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
