'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { requireAdmin, requireSession, scoped, firstRow } from '@/lib/tenancy'
import { createSupabaseAdminClient } from '@/lib/supabase/server'
import { siteUrl } from '@/lib/env'

// -----------------------------------------------------------------------------
// Pipelines and stages (PRD 6.3)
// -----------------------------------------------------------------------------

export async function createPipeline(formData: FormData) {
  const context = await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('A pipeline needs a name')

  const { data: pipeline, error } = await scoped(context, 'pipelines')
    .insert({ name, is_default: false })
    .select('id')
    .single()

  if (error) throw new Error(error.message)

  await scoped(context, 'stages').insert([
    { pipeline_id: pipeline.id, name: 'New', order: 0, default_probability: 0.1 },
    { pipeline_id: pipeline.id, name: 'Won', order: 1, default_probability: 1 },
  ])

  revalidatePath('/settings/pipelines')
}

export async function renamePipeline(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('A pipeline needs a name')

  const { error } = await scoped(context, 'pipelines').update({ name }).eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/settings/pipelines')
}

export async function setDefaultPipeline(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  // A partial unique index enforces one default per organization, so the old
  // default has to be cleared before the new one is set.
  await scoped(context, 'pipelines').update({ is_default: false }).eq('is_default', true)
  const { error } = await scoped(context, 'pipelines').update({ is_default: true }).eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/settings/pipelines')
}

export async function deletePipeline(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'pipelines').delete().eq('id', id)
  if (error) {
    throw new Error(
      error.message.includes('violates foreign key')
        ? 'This pipeline still has deals in it. Move them first.'
        : error.message,
    )
  }

  revalidatePath('/settings/pipelines')
}

export async function createStage(formData: FormData) {
  const context = await requireAdmin()
  const pipelineId = String(formData.get('pipeline_id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const probability = Number(formData.get('default_probability') ?? 50) / 100

  if (!name) throw new Error('A stage needs a name')

  const last = await firstRow<{ order: number }>(
    scoped(context, 'stages')
      .select('order')
      .eq('pipeline_id', pipelineId)
      .order('order', { ascending: false })
      .limit(1)
      .maybeSingle(),
  )

  const { error } = await scoped(context, 'stages').insert({
    pipeline_id: pipelineId,
    name,
    order: (last?.order ?? -1) + 1,
    default_probability: Math.min(1, Math.max(0, probability)),
  })

  if (error) throw new Error(error.message)
  revalidatePath('/settings/pipelines')
}

export async function updateStage(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const probability = Number(formData.get('default_probability') ?? 50) / 100
  const order = Number(formData.get('order') ?? 0)

  const { error } = await scoped(context, 'stages')
    .update({
      name,
      default_probability: Math.min(1, Math.max(0, probability)),
      order,
    })
    .eq('id', id)

  if (error) throw new Error(error.message)
  revalidatePath('/settings/pipelines')
}

export async function deleteStage(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'stages').delete().eq('id', id)
  if (error) {
    throw new Error(
      error.message.includes('violates foreign key')
        ? 'This stage still holds deals. Move them to another stage first.'
        : error.message,
    )
  }

  revalidatePath('/settings/pipelines')
}

// -----------------------------------------------------------------------------
// Users (PRD Section 4)
// -----------------------------------------------------------------------------

const inviteSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().max(120).default(''),
  role: z.enum(['admin', 'regular']).default('regular'),
})

export type InviteState = { ok?: string; error?: string }

/**
 * Provisions a person into *this* organization only.
 *
 * The service-role client is used to create the Supabase Auth user, which
 * bypasses RLS — so the caller's admin role is checked first, and the CRM user
 * row is written with the caller's own organization_id, never one supplied by
 * the request.
 */
export async function inviteUser(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const context = await requireAdmin()

  const parsed = inviteSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid invitation' }
  const { email, name, role } = parsed.data

  const { error: insertError } = await scoped(context, 'users').insert({
    email: email.toLowerCase(),
    name,
    role,
    status: 'invited',
  })

  if (insertError) {
    return {
      error: insertError.message.includes('duplicate key')
        ? 'Someone with that email is already in this organization.'
        : insertError.message,
    }
  }

  // Sending the actual auth invitation needs the service role. If it is not
  // configured, the CRM record still exists and the person can sign in with a
  // magic link, so this is a warning rather than a failure.
  try {
    const admin = createSupabaseAdminClient()
    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${siteUrl()}/auth/callback`,
    })
    if (inviteError && !inviteError.message.includes('already been registered')) {
      return { ok: `${email} was added, but the invitation email failed: ${inviteError.message}` }
    }
  } catch {
    return {
      ok: `${email} was added. No invitation email was sent (SUPABASE_SERVICE_ROLE_KEY is not configured) — they can sign in with an email link.`,
    }
  }

  revalidatePath('/settings/users')
  return { ok: `Invitation sent to ${email}.` }
}

export async function updateUserRole(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const role = String(formData.get('role') ?? 'regular') === 'admin' ? 'admin' : 'regular'

  // Never let the last administrator demote themselves out of the organization.
  if (id === context.user.id && role === 'regular') {
    const { count } = await scoped(context, 'users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('status', 'active')

    if ((count ?? 0) <= 1) {
      throw new Error('This organization needs at least one administrator.')
    }
  }

  const { error } = await scoped(context, 'users').update({ role }).eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/settings/users')
}

export async function updateUserStatus(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const status = String(formData.get('status') ?? 'active')

  if (id === context.user.id && status === 'disabled') {
    throw new Error('You cannot disable your own account.')
  }

  const { error } = await scoped(context, 'users')
    .update({ status: status === 'disabled' ? 'disabled' : 'active' })
    .eq('id', id)

  if (error) throw new Error(error.message)
  revalidatePath('/settings/users')
}

// -----------------------------------------------------------------------------
// Lead scoring (PRD 5.12, 6.5)
// -----------------------------------------------------------------------------

export async function createLeadScoreRule(formData: FormData) {
  const context = await requireAdmin()

  const { error } = await scoped(context, 'lead_score_rules').insert({
    field: String(formData.get('field') ?? '').trim(),
    condition: String(formData.get('condition') ?? 'equals') as never,
    value: String(formData.get('value') ?? '').trim() || null,
    points: Number(formData.get('points') ?? 0),
  })

  if (error) throw new Error(error.message)

  // A new rule changes existing contacts' scores, so recompute immediately —
  // acceptance criterion 6.5 says the effect must be visible without a deploy.
  await context.supabase.rpc('recalculate_lead_scores')

  revalidatePath('/settings/lead-scoring')
  revalidatePath('/contacts')
}

export async function deleteLeadScoreRule(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'lead_score_rules').delete().eq('id', id)
  if (error) throw new Error(error.message)

  await context.supabase.rpc('recalculate_lead_scores')

  revalidatePath('/settings/lead-scoring')
  revalidatePath('/contacts')
}

export async function recalculateScores() {
  const context = await requireSession()
  const { error } = await context.supabase.rpc('recalculate_lead_scores')
  if (error) throw new Error(error.message)

  revalidatePath('/settings/lead-scoring')
  revalidatePath('/contacts')
}

// -----------------------------------------------------------------------------
// Assignment rules (PRD 6.5)
// -----------------------------------------------------------------------------

export async function createAssignmentRule(formData: FormData) {
  const context = await requireAdmin()
  const strategy = String(formData.get('strategy') ?? 'round_robin')

  const { error } = await scoped(context, 'assignment_rules').insert({
    name: String(formData.get('name') ?? '').trim() || 'Rule',
    strategy: strategy as never,
    source_match: strategy === 'by_source' ? String(formData.get('source_match') ?? '').trim() : null,
    fixed_user_id:
      strategy === 'round_robin' ? null : String(formData.get('fixed_user_id') ?? '') || null,
    priority: Number(formData.get('priority') ?? 0),
  })

  if (error) throw new Error(error.message)
  revalidatePath('/settings/assignment')
}

export async function deleteAssignmentRule(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'assignment_rules').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/settings/assignment')
}

// -----------------------------------------------------------------------------
// Custom field definitions
// -----------------------------------------------------------------------------

export async function createCustomField(formData: FormData) {
  const context = await requireAdmin()

  const label = String(formData.get('label') ?? '').trim()
  const key =
    String(formData.get('key') ?? '').trim() ||
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')

  if (!label || !key) throw new Error('A custom field needs a label')

  const options = String(formData.get('options') ?? '')
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean)

  const { error } = await scoped(context, 'custom_field_definitions').insert({
    entity_type: String(formData.get('entity_type') ?? 'contact') as never,
    key,
    label,
    field_type: String(formData.get('field_type') ?? 'text') as never,
    options,
  })

  if (error) {
    throw new Error(
      error.message.includes('duplicate key')
        ? `A "${key}" field already exists for that record type.`
        : error.message,
    )
  }

  revalidatePath('/settings/fields')
}

export async function deleteCustomField(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'custom_field_definitions').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/settings/fields')
}

// -----------------------------------------------------------------------------
// Tags (PRD 5.9)
// -----------------------------------------------------------------------------

export async function createTag(formData: FormData) {
  const context = await requireSession()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('A tag needs a name')

  const { error } = await scoped(context, 'tags').insert({
    name,
    color: String(formData.get('color') ?? '#64748b'),
  })

  if (error) {
    throw new Error(
      error.message.includes('duplicate key') ? `The tag "${name}" already exists.` : error.message,
    )
  }

  revalidatePath('/settings/tags')
}

export async function deleteTag(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'tags').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/settings/tags')
}

// -----------------------------------------------------------------------------
// Organization settings (PRD 8.1, available early since it is trivial)
// -----------------------------------------------------------------------------

export async function updateOrganization(formData: FormData) {
  const context = await requireAdmin()

  const { error } = await context.supabase
    .from('organizations')
    .update({
      name: String(formData.get('name') ?? '').trim() || context.organization.name,
      primary_color: String(formData.get('primary_color') ?? context.organization.primary_color),
      default_currency: String(formData.get('default_currency') ?? 'CAD').toUpperCase(),
      logo_url: String(formData.get('logo_url') ?? '').trim() || null,
    })
    .eq('id', context.organizationId)

  if (error) throw new Error(error.message)
  revalidatePath('/', 'layout')
}
