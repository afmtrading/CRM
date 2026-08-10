import { NextResponse } from 'next/server'

import { getSessionContext, scoped } from '@/lib/tenancy'

/** GET /imports/{id} — poll import status and per-row results (PRD Section 9). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await getSessionContext()

  if (!context) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data, error } = await scoped(context, 'import_jobs').select('*').eq('id', id).maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Import job not found' }, { status: 404 })

  return NextResponse.json({ job: data })
}
