import { NextResponse, type NextRequest } from 'next/server'

import { getSessionContext, scoped, type TenantTable } from '@/lib/tenancy'
import { applyFilter, filterFromSearchParams } from '@/lib/filters'
import { toCsv } from '@/lib/csv'
import type { FilterEntityType } from '@/lib/database.types'

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
}

export async function GET(request: NextRequest) {
  const context = await getSessionContext()
  if (!context) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
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

  const table = ENTITY_TABLES[entity]
  if (!table) {
    return NextResponse.json({ error: `Unknown entity "${entity}"` }, { status: 400 })
  }

  let query = scoped(context, table).select('*')

  // Contacts, companies and deals carry the filter UI, so an export mirrors
  // exactly what the user is looking at.
  if (['contact', 'company', 'deal'].includes(entity)) {
    const config = filterFromSearchParams(params)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = applyFilter(query as any, config, entity as FilterEntityType) as any
    if (entity === 'contact') query = query.is('duplicate_of_id', null)
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
