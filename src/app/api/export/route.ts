import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'

import { getSessionContext, scoped, type TenantTable } from '@/lib/tenancy'
import { applyFilter, filterFromSearchParams, matchesFilter } from '@/lib/filters'
import {
  DEFAULT_COLUMNS,
  LEDGER_COLUMNS_COOKIE,
  applyLedgerFilter,
  exportColumns,
  ledgerCsvRow,
  ledgerFilterFromParams,
  parseColumns,
  parseSort,
  regionFieldKey,
  resolveColumns,
  sortLedger,
  type LedgerRow,
} from '@/lib/ledger'
import { toCsv } from '@/lib/csv'
import type { CustomFieldDefinitionRow, FilterEntityType } from '@/lib/database.types'

/**
 * GET /export — bulk export of any filtered view (PRD 6.7), and the manual
 * backup path referenced in Section 10.
 *
 * `?entity=all` walks every tenant table, which is what makes the retention
 * requirement ("an organization's data could be fully reconstructed from an
 * export file alone") true rather than aspirational.
 */

const ENTITY_TABLES: Record<string, TenantTable> = {
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
  activity: 'activities',
  tag: 'tags',
  pipeline: 'pipelines',
  stage: 'stages',
  user: 'users',
  saved_filter: 'saved_filters',
  lead_score_rule: 'lead_score_rules',
  assignment_rule: 'assignment_rules',
  custom_field_definition: 'custom_field_definitions',
  contact_tag: 'contact_tags',
  company_tag: 'company_tags',
  product: 'products',
}

export async function GET(request: NextRequest) {
  const context = await getSessionContext()
  if (!context) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Export is the one action that can put the whole customer list in a file, so
  // it is held to the same bar as deleting and importing.
  if (!context.canBulk) {
    return NextResponse.json(
      { error: 'Your role does not allow exporting.' },
      { status: 403 },
    )
  }

  const params = Object.fromEntries(request.nextUrl.searchParams.entries())
  const entity = params.entity ?? 'contact'

  // Full-organization export: one JSON document containing every table.
  if (entity === 'all') {
    const dump: Record<string, unknown[]> = {}

    for (const [name, table] of Object.entries(ENTITY_TABLES)) {
      const { data } = await scoped(context, table).select('*')
      dump[name] = data ?? []
    }

    const body = JSON.stringify(
      {
        organization: context.organization,
        exported_at: new Date().toISOString(),
        exported_by: context.user.email,
        data: dump,
      },
      null,
      2,
    )

    return new NextResponse(body, {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="${context.organization.slug}-full-export-${new Date()
          .toISOString()
          .slice(0, 10)}.json"`,
      },
    })
  }

  /*
   * The deal ledger is not a table, so it cannot go through the generic path
   * below. It runs the same filter and sort the screen does — literally the
   * same functions — so the file and the page can never disagree about which
   * deals are in the report.
   */
  if (entity === 'deal_ledger') {
    const { data: definitions } = await scoped(context, 'custom_field_definitions').select('*')
    const regionKey = regionFieldKey((definitions ?? []) as CustomFieldDefinitionRow[])

    const { data: ledger, error: ledgerError } = await context.supabase.rpc('deal_ledger', {
      p_region_key: regionKey,
    })

    if (ledgerError) {
      return NextResponse.json({ error: ledgerError.message }, { status: 500 })
    }

    const rows = sortLedger(
      applyLedgerFilter((ledger ?? []) as LedgerRow[], ledgerFilterFromParams(params)),
      parseSort(params.sort),
    )

    /*
     * The file carries the columns the screen is showing, in the same order.
     * Resolved the same way the page resolves them — the link carries `cols`,
     * and the cookie answers for anybody who reached this URL directly.
     */
    const jar = await cookies()
    const chosen =
      parseColumns(params.cols) ?? parseColumns(jar.get(LEDGER_COLUMNS_COOKIE)?.value) ?? DEFAULT_COLUMNS

    const columns = exportColumns(resolveColumns(chosen, regionKey !== null))
    const date = new Date().toISOString().slice(0, 10)

    return new NextResponse(toCsv(rows.map((row) => ledgerCsvRow(row, columns))), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${context.organization.slug}-deal-ledger-${date}.csv"`,
      },
    })
  }

  /*
   * Marketplaces are not a table either — they are the companies that have a
   * profile — and the filter that produced the view was evaluated in memory
   * rather than in the query, for the reasons set out beside MARKETPLACE_FIELDS.
   * So the export does the same: fetch the joined rows, run the same predicate
   * the page ran, and flatten the profile in beside the company.
   */
  if (entity === 'marketplace') {
    const { data, error } = await scoped(context, 'companies')
      .select('*, marketplace_profiles!inner(*)')
      .is('deleted_at', null)
      .order('name')
      .limit(50_000)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const config = filterFromSearchParams(params)
    const rows = ((data ?? []) as Record<string, unknown>[])
      .filter((row) => matchesFilter(row, config, 'marketplace'))
      .map(({ marketplace_profiles: profile, ...company }) => ({
        ...company,
        // Prefixed, because a company and its profile both have a created_at
        // and a flattened row must not lose one of them.
        ...Object.fromEntries(
          Object.entries((profile ?? {}) as Record<string, unknown>).map(([key, value]) => [
            `marketplace_${key}`,
            value,
          ]),
        ),
      }))

    const date = new Date().toISOString().slice(0, 10)
    return new NextResponse(toCsv(rows), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${context.organization.slug}-marketplaces-${date}.csv"`,
      },
    })
  }

  const table = ENTITY_TABLES[entity]
  if (!table) {
    return NextResponse.json({ error: `Unknown entity "${entity}"` }, { status: 400 })
  }

  let query = scoped(context, table).select('*')

  // These carry the filter UI, so an export mirrors exactly what the user is
  // looking at.
  if (['contact', 'company', 'deal', 'product'].includes(entity)) {
    const config = filterFromSearchParams(params)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = applyFilter(query as any, config, entity as FilterEntityType) as any
    if (entity === 'contact') query = query.is('duplicate_of_id', null)
    if (entity === 'product') query = query.is('deleted_at', null)
  }

  const { data, error } = await query.limit(50_000)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const csv = toCsv((data ?? []) as Record<string, unknown>[])
  const date = new Date().toISOString().slice(0, 10)

  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${context.organization.slug}-${entity}s-${date}.csv"`,
    },
  })
}
