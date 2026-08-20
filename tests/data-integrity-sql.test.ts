import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { OPTION_FIELDS, OPTION_VALUE_COLUMNS } from '../src/lib/field-options'

/*
 * The data-integrity check has to know which column holds the values a list
 * produces, and SQL cannot import that from anywhere. So the pairing was
 * restated in the script, and nothing would have said if it drifted from the
 * app's — a renamed column, or a new list nobody added to the check, would have
 * shown up as a silent run of zero findings rather than as a failure.
 *
 * Zero findings is what a clean database looks like, which is exactly why it is
 * a dangerous thing to get for the wrong reason.
 *
 * These read the script and hold it to OPTION_VALUE_COLUMNS.
 */
const SQL = readFileSync(new URL('../supabase/checks/data-integrity.sql', import.meta.url), 'utf8')

/** field_options is always aliased `o`; its columns are the lookup, not a value. */
const LOOKUP_ALIAS = 'o'

type Pair = { table: string; key: string; column: string }

/**
 * The (table, key, column) triples the script actually joins on.
 *
 * Each option key literal is paired with the first column reference that
 * follows it, stopping at the next key literal. That is the shape every branch
 * of the script happens to take — `'stock_type', unnest(co.stock_type)`,
 * `('product_status', p.status)`, `'marketplace_payment', mp.payment` — and the
 * alias in front of the column is what says which table it came from, which
 * matters because three separate lists are called priority.
 */
function pairsFromSql(sql: string): Pair[] {
  const known = new Set(OPTION_VALUE_COLUMNS.map((entry) => entry.key as string))
  const pairs: Pair[] = []

  for (const [, name, body] of blocks(sql)) {
    const aliases = aliasTables(body)
    // Every key literal in this block, in order, so each one bounds the next.
    const hits = [...body.matchAll(/'([a-z_]+)'/g)].filter((hit) => known.has(hit[1]))

    hits.forEach((hit, index) => {
      const from = hit.index! + hit[0].length
      const to = index + 1 < hits.length ? hits[index + 1].index! : body.length
      const window = body.slice(from, to)

      for (const ref of window.matchAll(/(?:unnest\()?([a-z]{1,3})\.([a-z_]+)/g)) {
        const [, alias, column] = ref
        if (alias === LOOKUP_ALIAS) continue // o.value, o.field_key — the lookup side
        const table = aliases.get(alias)
        if (table) pairs.push({ table, key: hit[1], column })
        break
      }
    })

    expect(name).toBeTruthy()
  }

  return dedupe(pairs)
}

/** Each `name as ( … )` in the script, split on the next one starting. */
function blocks(sql: string): [string, string, string][] {
  const starts = [...sql.matchAll(/^([a-z_]+) as \($/gm)]
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index! : sql.length
    return ['', start[1], sql.slice(start.index! + start[0].length, end)]
  })
}

/** Alias to table, reading the block's own from/join clauses. live_x is x. */
function aliasTables(body: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const [, table, alias] of body.matchAll(/(?:from|join)\s+([a-z_]+)\s+([a-z]{1,3})\b/g)) {
    map.set(alias, table.replace(/^live_/, ''))
  }
  return map
}

function dedupe(pairs: Pair[]): Pair[] {
  const seen = new Map<string, Pair>()
  for (const pair of pairs) seen.set(`${pair.table}.${pair.key}.${pair.column}`, pair)
  return [...seen.values()].sort((a, b) => key(a).localeCompare(key(b)))
}

const key = (pair: Pair) => `${pair.table}.${pair.key}.${pair.column}`

const declared = OPTION_VALUE_COLUMNS.map(({ table, key: k, column }) => ({ table, key: k, column }))

describe('the check and the app agree on where values are stored', () => {
  /*
   * Both directions matter and they fail for different reasons. A declared pair
   * missing from the script is a list nothing checks. A pair in the script that
   * nothing declares is a check reading a column no longer written to, which
   * reports nothing forever and looks like health.
   */
  it('checks every list the app declares, and no others', () => {
    expect(pairsFromSql(SQL).map(key)).toEqual(dedupe(declared).map(key))
  })

  it('finds a pairing for all twenty lists, so a silent parse cannot pass it', () => {
    expect(pairsFromSql(SQL)).toHaveLength(20)
  })

  // The pairing is only interesting where key and column differ; if the parse
  // ever stopped seeing those, the rest would still match by coincidence.
  it('reads the pairs whose key is not its column', () => {
    expect(pairsFromSql(SQL)).toEqual(
      expect.arrayContaining([
        { table: 'products', key: 'product_category', column: 'category' },
        { table: 'products', key: 'product_status', column: 'status' },
        { table: 'marketplace_profiles', key: 'marketplace_fulfilment', column: 'fulfilment' },
        { table: 'marketplace_profiles', key: 'marketplace_account_status', column: 'account_status' },
      ]),
    )
  })

  it('keeps the three separate priority lists apart', () => {
    const priorities = pairsFromSql(SQL).filter((pair) => pair.key === 'priority')
    expect(priorities.map((pair) => pair.table).sort()).toEqual(['companies', 'contacts', 'products'])
  })
})

describe('every option list has somewhere to store what it produces', () => {
  /*
   * OPTION_FIELDS is where a list is added. Without this, adding one there is
   * all it takes to have a field the check silently ignores.
   */
  it('declares a column for each built-in list', () => {
    const stored = new Set(OPTION_VALUE_COLUMNS.map((entry) => `${entry.entity}.${entry.key}`))
    const missing = OPTION_FIELDS.filter((field) => !stored.has(`${field.entity}.${field.key}`))
    expect(missing.map((field) => `${field.entity}.${field.key}`)).toEqual([])
  })

  it('declares nothing the app does not offer', () => {
    const offered = new Set(OPTION_FIELDS.map((field) => `${field.entity}.${field.key}`))
    const extra = OPTION_VALUE_COLUMNS.filter((entry) => !offered.has(`${entry.entity}.${entry.key}`))
    expect(extra.map((entry) => `${entry.entity}.${entry.key}`)).toEqual([])
  })

  // A single-value column cannot hold a multi-select, so disagreeing here means
  // one of the two is wrong about what the field is.
  it('agrees with OPTION_FIELDS on which lists take more than one value', () => {
    for (const entry of OPTION_VALUE_COLUMNS) {
      const field = OPTION_FIELDS.find((f) => f.entity === entry.entity && f.key === entry.key)
      expect(`${entry.key}:${entry.multiple}`).toBe(`${entry.key}:${field?.multiple}`)
    }
  })
})
