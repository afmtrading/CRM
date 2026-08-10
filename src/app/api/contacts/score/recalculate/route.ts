import { NextResponse } from 'next/server'

import { getSessionContext } from '@/lib/tenancy'

/**
 * POST /contacts/score/recalculate (PRD Section 9)
 *
 * Re-runs the organization's LeadScoreRules against its existing contacts,
 * which is what makes a rule change visible without a deploy (6.5).
 */
export async function POST() {
  const context = await getSessionContext()
  if (!context) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data, error } = await context.supabase.rpc('recalculate_lead_scores')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ contacts_updated: data ?? 0 })
}
