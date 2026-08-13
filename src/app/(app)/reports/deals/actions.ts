'use server'

import { cookies } from 'next/headers'

import { LEDGER_COLUMNS_COOKIE, columnsParam, parseColumns } from '@/lib/ledger'

/**
 * Remembers a chosen column layout.
 *
 * The nav link to the ledger carries no query string, so a layout that lived
 * only in the URL would be thrown away every time somebody clicked Reports.
 * This is the cheapest place to remember one: a cookie the server reads while
 * rendering, which needs no table, no migration and no round trip after the
 * page loads.
 *
 * It is a display preference and nothing else — no record, no filter, nothing
 * anybody else can see — so it is stored per browser rather than against the
 * account. Somebody signing in elsewhere gets the default layout, which is a
 * reasonable place to start rather than something they have lost.
 */
export async function rememberLedgerColumns(raw: string | null) {
  const jar = await cookies()

  const keys = parseColumns(raw)
  if (!keys) {
    jar.delete(LEDGER_COLUMNS_COOKIE)
    return
  }

  jar.set(LEDGER_COLUMNS_COOKIE, columnsParam(keys), {
    path: '/',
    // A year: a column layout is not a thing anybody wants to set twice.
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    sameSite: 'lax',
  })
}
