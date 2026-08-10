import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getSessionContext } from '@/lib/tenancy'

/**
 * POST /contacts/{id}/merge (PRD Section 9)
 *
 * Merges the duplicate named in the body into the contact in the path. The
 * work happens inside merge_contacts() so reassigning deals, activities and
 * tags is one transaction, not four round trips that can half-fail.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await getSessionContext()

  if (!context) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const parsed = z
    .object({ source_id: z.string().uuid() })
    .safeParse(await request.json().catch(() => ({})))

  if (!parsed.success) {
    return NextResponse.json({ error: 'source_id (uuid) is required' }, { status: 400 })
  }

  const { data, error } = await context.supabase.rpc('merge_contacts', {
    p_target_id: id,
    p_source_id: parsed.data.source_id,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ contact: data })
}
