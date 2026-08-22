import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { OPTION_VALUE_COLUMNS } from '../src/lib/field-options'

/*
 * Renaming an option rewrites the value on every record carrying it, and which
 * column holds that value is a pairing only the app knows — OPTION_VALUE_COLUMNS
 * is the list, and the action passes the table and column to the function.
 *
 * The function will not be told just anything: security definer runs past RLS,
 * so it scopes by organization_id itself and refuses a table it does not
 * recognise. That whitelist is the one place the SQL restates something the app
 * owns, and a list gaining an entry on a table the function has never heard of
 * would fail at the moment somebody renamed an option — not here, where it is
 * cheap.
 */
const SQL = readFileSync(
  new URL('../supabase/migrations/20260274000000_renaming_an_option.sql', import.meta.url),
  'utf8',
)

/** The `p_table not in (...)` guard of one function, as a set of table names. */
function guardedTables(functionName: string): Set<string> {
  const body = SQL.slice(SQL.indexOf(`function public.${functionName}(`))
  const guard = /p_table not in \(([^)]+)\)/.exec(body)
  expect(guard, `${functionName} has no table whitelist`).not.toBeNull()

  return new Set([...guard![1].matchAll(/'([a-z_]+)'/g)].map((hit) => hit[1]))
}

describe('the tables a rename is allowed to rewrite', () => {
  it('covers every table a built-in option list stores its values on', () => {
    const allowed = guardedTables('rename_option_value')

    for (const entry of OPTION_VALUE_COLUMNS) {
      expect(allowed, `${entry.entity}.${entry.key} writes to ${entry.table}`).toContain(entry.table)
    }
  })

  // The custom-field path writes into `custom_fields`, which only the four
  // record types have — marketplace_profiles is a company's extra card, not a
  // record somebody defines fields on.
  it('allows exactly the records that carry a custom_fields document', () => {
    expect([...guardedTables('rename_custom_field_value')].sort()).toEqual([
      'companies',
      'contacts',
      'deals',
      'products',
    ])
  })

  it('names no table the built-in path does not need', () => {
    const allowed = guardedTables('rename_option_value')
    const used = new Set(OPTION_VALUE_COLUMNS.map((entry) => entry.table))

    for (const table of allowed) {
      expect(used, `${table} is whitelisted but no option list writes to it`).toContain(table)
    }
  })
})
