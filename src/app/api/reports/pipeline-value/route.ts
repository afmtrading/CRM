import { NextResponse, type NextRequest } from 'next/server'

import { getSessionContext } from '@/lib/tenancy'
import type { PipelineValueReportRow } from '@/lib/database.types'

/** GET /reports/pipeline-value — filterable by stage and owner (PRD Section 9). */
export async function GET(request: NextRequest) {
  const context = await getSessionContext()
  if (!context) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const pipelineId = request.nextUrl.searchParams.get('pipeline_id')
  const ownerId = request.nextUrl.searchParams.get('owner_id')
  const stageId = request.nextUrl.searchParams.get('stage_id')

  const { data, error } = await context.supabase.rpc('report_pipeline_value', {
    p_pipeline_id: pipelineId,
    p_owner_id: ownerId,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = ((data ?? []) as PipelineValueReportRow[]).filter(
    (row) => !stageId || row.stage_id === stageId,
  )

  return NextResponse.json({
    organization_id: context.organizationId,
    generated_at: new Date().toISOString(),
    rows,
  })
}
