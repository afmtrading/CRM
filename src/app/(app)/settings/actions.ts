'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { assertCanManage, requireAdmin, requireSession, scoped, firstRow } from '@/lib/tenancy'
import type { ActionState } from '@/components/action-form'
import { safeTimeZone } from '@/lib/timezone'
import { CURRENCIES } from '@/lib/format'
import { createSupabaseAdminClient } from '@/lib/supabase/server'
import { siteUrl } from '@/lib/env'
import { OPTION_COLORS, OPTION_FIELDS } from '@/lib/field-options'
import { visibilityColumns } from '@/lib/permissions'
import { resolveStatus, wouldRemoveLastAdmin, type UserSnapshot } from '@/lib/users'
import type { OptionColor, StageOutcome } from '@/lib/database.types'

// -----------------------------------------------------------------------------
// Pipelines and stages (PRD 6.3)
// -----------------------------------------------------------------------------

export async function createPipeline(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'A pipeline needs a name' }

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
  return { ok: `${name} added, with a New and a Won stage to start from.` }
}

/**
 * Renames a pipeline.
 *
 * A pipeline's name is a label on the board, not a key: deals point at stages,
 * and stages at the pipeline's id, so nothing breaks when it changes. Which is
 * exactly why it should be editable — "Trading desk" outliving the desk is
 * silly when the fix is one word.
 */
export async function renamePipeline(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()

  if (!name) return { error: 'A pipeline needs a name' }
  if (name.length > 120) return { error: 'That name is too long' }

  const { error } = await scoped(context, 'pipelines').update({ name }).eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/settings/pipelines')
  // The board and its picker are named from this too.
  revalidatePath('/deals')
  return { ok: `Renamed to ${name}.` }
}

/**
 * One place left or right in the pipeline bar.
 *
 * The same shape as moveStage, and for the same reason: the neighbour is
 * resolved in the database so a read and a write cannot interleave with another
 * administrator's reorder.
 */
export async function movePipeline(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const delta = formData.get('direction') === 'up' ? -1 : 1

  const { error } = await context.supabase.rpc('move_pipeline', {
    p_pipeline_id: id,
    p_delta: delta,
  })

  if (error) throw new Error(error.message)

  revalidatePath('/settings/pipelines')
  // The bar above the board is drawn from this order.
  revalidatePath('/deals')
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

/**
 * Retires a pipeline: deleted if nothing refers to it, archived if something
 * does, refused while deals are still on the board.
 *
 * The database decides which of the three, because it is the only thing that
 * knows — a pipeline is undeletable the moment any deal has ever entered one of
 * its stages, since the stage history keeps pointing at it long after the deal
 * has moved on. This used to throw the resulting foreign key error, which
 * reached the browser as a digest and nothing else, and offered advice ("move
 * the deals first") that could not work.
 */
export async function retirePipeline(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? 'That pipeline')

  const { data, error } = await context.supabase.rpc('remove_pipeline', { p_pipeline_id: id })
  if (error) return { error: error.message }

  revalidatePath('/settings/pipelines')
  revalidatePath('/deals')

  return {
    ok:
      data === 'deleted'
        ? `${name} deleted.`
        : `${name} has deals in its history, so it has been archived rather than deleted. It is off the board and out of the pickers, and can be restored.`,
  }
}

export async function restorePipeline(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('restore_pipeline', { p_pipeline_id: id })
  if (error) return { error: error.message }

  revalidatePath('/settings/pipelines')
  revalidatePath('/deals')
  return {}
}

export async function createStage(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireAdmin()
  const pipelineId = String(formData.get('pipeline_id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const probability = Number(formData.get('default_probability') ?? 50) / 100

  if (!name) return { error: 'A stage needs a name' }

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
  return { ok: `${name} added.` }
}

/**
 * Saves a stage's name, probability and position.
 *
 * The position does not go through this update. Writing the column directly is
 * what made "2" mean "somewhere around second": nothing stopped two stages
 * holding the same number, and the tie was then broken arbitrarily. It goes to
 * reorder_stage, which renumbers the whole pipeline so the number typed is the
 * position taken.
 */
export async function updateStage(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const probability = Number(formData.get('default_probability') ?? 50) / 100
  const position = Number(formData.get('order') ?? 0)
  const rawOutcome = String(formData.get('outcome') ?? '')

  if (!name) return { error: 'A stage needs a name' }

  /*
   * What reaching this stage means. Only ever set from the three the database
   * knows; anything else leaves it alone rather than writing a value the
   * deals trigger would not recognise.
   */
  const outcome =
    rawOutcome === 'open' || rawOutcome === 'won' || rawOutcome === 'lost'
      ? (rawOutcome as StageOutcome)
      : undefined

  const { error } = await scoped(context, 'stages')
    .update({
      name,
      default_probability: Math.min(1, Math.max(0, probability)),
      ...(outcome ? { outcome } : {}),
    })
    .eq('id', id)

  if (error) throw new Error(error.message)

  if (Number.isFinite(position)) {
    const { error: orderError } = await context.supabase.rpc('reorder_stage', {
      p_stage_id: id,
      p_position: Math.max(0, Math.trunc(position)),
    })
    if (orderError) throw new Error(orderError.message)
  }

  revalidatePath('/settings/pipelines')
  revalidatePath('/deals')
  return { ok: 'Saved.' }
}

/** One place up or down — what an arrow means, resolved in one transaction. */
export async function moveStage(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const delta = formData.get('direction') === 'up' ? -1 : 1

  const { error } = await context.supabase.rpc('move_stage', {
    p_stage_id: id,
    p_delta: delta,
  })

  if (error) throw new Error(error.message)

  revalidatePath('/settings/pipelines')
  revalidatePath('/deals')
}

/** The same three outcomes as a pipeline, one level down. */
export async function retireStage(_state: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { data, error } = await context.supabase.rpc('remove_stage', { p_stage_id: id })
  if (error) return { error: error.message }

  revalidatePath('/settings/pipelines')
  revalidatePath('/deals')

  return {
    ok:
      data === 'deleted'
        ? 'Stage deleted.'
        : 'That stage has deals in its history, so it has been archived rather than deleted. It can be restored.',
  }
}

export async function restoreStage(_state: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('restore_stage', { p_stage_id: id })
  if (error) return { error: error.message }

  revalidatePath('/settings/pipelines')
  revalidatePath('/deals')
  return {}
}

// -----------------------------------------------------------------------------
// Permission sets
//
// Every write goes through a definer function rather than through the table.
// The table has no write policy at all, deliberately: a row-level rule can say
// who may change a row, but it cannot say "and afterwards somebody must still
// be able to get back in". Both lockouts — nobody who can reach Settings,
// nobody who can edit permissions — are questions about the organization after
// the write, which only something that owns the write can ask.
//
// So the checks below are about failing early with a readable message. The ones
// that matter are a layer down, and these actions pass their wording through
// rather than inventing their own.
// -----------------------------------------------------------------------------

async function requirePermissionManager() {
  const context = await requireSession()
  if (!context.canManagePermissions) {
    redirect('/?error=permission')
  }
  return context
}

export async function createPermissionSet(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requirePermissionManager()
  const name = String(formData.get('name') ?? '').trim()

  if (!name) return { error: 'A permission set needs a name' }

  const { error } = await context.supabase.rpc('create_permission_set', { p_name: name })
  if (error) return { error: error.message }

  revalidatePath('/settings/permissions')
  return { ok: `${name} created. Nothing is ticked on it yet.` }
}

export async function updatePermissionSet(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requirePermissionManager()

  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const visibility = visibilityColumns(String(formData.get('visibility') ?? ''))
  const ticked = (key: string) => formData.get(key) === 'on'

  const { error } = await context.supabase.rpc('update_permission_set', {
    p_id: id,
    p_name: name,
    p_see_all_records: visibility.see_all_records,
    p_see_unassigned: visibility.see_unassigned,
    p_write_records: ticked('write_records'),
    p_delete_records: ticked('delete_records'),
    p_manage_records: ticked('manage_records'),
    p_bulk_records: ticked('bulk_records'),
    p_administer: ticked('administer'),
    p_manage_permissions: ticked('manage_permissions'),
    p_see_hidden: ticked('see_hidden'),
  })

  if (error) return { error: error.message }

  revalidatePath('/settings/permissions')
  revalidatePath('/settings/users')
  return { ok: 'Saved.' }
}

export async function deletePermissionSet(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requirePermissionManager()

  const { error } = await context.supabase.rpc('delete_permission_set', {
    p_id: String(formData.get('id') ?? ''),
  })

  if (error) return { error: error.message }

  revalidatePath('/settings/permissions')
  return {}
}

/**
 * Puts somebody on a set, or takes them off it.
 *
 * An empty value means "resolve through your role again" — where everybody
 * starts, and where somebody goes back to when their set is taken away.
 */
export async function assignPermissionSet(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requirePermissionManager()

  const { error } = await context.supabase.rpc('assign_permission_set', {
    p_user_id: String(formData.get('user_id') ?? ''),
    p_set_id: String(formData.get('permission_set_id') ?? '') || null,
  })

  if (error) return { error: error.message }

  revalidatePath('/settings/users')
  revalidatePath('/settings/permissions')
  return { ok: 'Saved.' }
}

// -----------------------------------------------------------------------------
// Users (PRD Section 4)
// -----------------------------------------------------------------------------

const userRoles = ['admin', 'manager', 'sales_director', 'regular', 'readonly'] as const

const inviteSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().max(120).default(''),
  role: z.enum(userRoles).default('regular'),
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

/**
 * Name, role and access in one edit, because that is how an administrator
 * thinks about a colleague — not as three separate settings that each need
 * saving.
 *
 * The role is parsed against the full list rather than coerced: treating
 * anything that is not 'admin' as 'regular' would silently demote a manager to
 * a rep, or a read-only user to one who can write.
 */
const userEditSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().max(120, 'A name has to be 120 characters or fewer'),
  role: z.enum(userRoles),
  status: z.enum(['active', 'disabled']),
})

/**
 * Guards on this page refuse ordinary, reasonable-looking actions — pausing the
 * last administrator, deleting yourself. Thrown from a server action those
 * become a full-page "server-side exception", which reads as a broken app
 * rather than a rule. They come back as a message on the page instead.
 */
function backToUsers(params: Record<string, string>): never {
  const query = new URLSearchParams(params)
  redirect(`/settings/users?${query.toString()}`)
}

/** The snapshot every guard below needs, fetched once. */
async function loadUser(context: Awaited<ReturnType<typeof requireAdmin>>, id: string) {
  const { data } = await scoped(context, 'users')
    .select('id, role, status, auth_provider_id')
    .eq('id', id)
    .maybeSingle()

  // Most likely a stale page — somebody else removed them while this one was
  // open. That is not an exception, it is out-of-date information.
  if (!data) backToUsers({ error: 'That person is no longer in this organization.' })
  return data as UserSnapshot
}

async function countActiveAdmins(context: Awaited<ReturnType<typeof requireAdmin>>) {
  const { count } = await scoped(context, 'users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('status', 'active')

  return count ?? 0
}

export async function updateUser(formData: FormData) {
  const context = await requireAdmin()

  const parsed = userEditSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    backToUsers({ error: parsed.error.issues[0]?.message ?? 'That change could not be saved.' })
  }
  const { id, name, role, status } = parsed.data

  const user = await loadUser(context, id)
  const nextStatus = resolveStatus(status, user)

  if (id === context.user.id && nextStatus === 'disabled') {
    backToUsers({ error: 'You cannot pause your own account.' })
  }

  if (
    wouldRemoveLastAdmin({
      user,
      activeAdminCount: await countActiveAdmins(context),
      next: { role, status: nextStatus },
    })
  ) {
    backToUsers({
      error:
        'This organization needs at least one administrator who can sign in. Give somebody else the administrator role first.',
    })
  }

  const { error } = await scoped(context, 'users')
    .update({ name, role, status: nextStatus })
    .eq('id', id)

  if (error) backToUsers({ error: error.message })

  revalidatePath('/settings/users')
  backToUsers({ saved: name || user.id })
}

/**
 * Removes somebody from the organization for good.
 *
 * Their work is not deleted with them. Every ownership column is
 * `on delete set null`, so contacts, companies, deals and activities survive as
 * unassigned records rather than disappearing with the person who happened to
 * own them. What does go is theirs alone: saved filters, notifications, and any
 * connected mailbox — which is the point, since a departed colleague's mailbox
 * should stop being read. An assignment rule pointing at them goes too.
 *
 * Their sign-in account at the authentication layer is left alone. It may be
 * shared with another organization, and losing the CRM record is already enough
 * to end their access here.
 *
 * Pausing is the reversible option and is usually what somebody wants; this one
 * has no undo, because users have no recycle bin.
 */
export async function deleteUser(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  if (id === context.user.id) {
    backToUsers({ error: 'You cannot delete your own account.' })
  }

  const user = await loadUser(context, id)

  if (wouldRemoveLastAdmin({ user, activeAdminCount: await countActiveAdmins(context) })) {
    backToUsers({
      error:
        'This organization needs at least one administrator who can sign in. Give somebody else the administrator role first.',
    })
  }

  const { error } = await scoped(context, 'users').delete().eq('id', id)
  if (error) backToUsers({ error: error.message })

  revalidatePath('/settings/users')
  backToUsers({ removed: String(formData.get('label') ?? 'That person') })
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

export async function createCustomField(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireAdmin()

  const label = String(formData.get('label') ?? '').trim()
  const key =
    String(formData.get('key') ?? '').trim() ||
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')

  if (!label || !key) return { error: 'A custom field needs a label' }

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
    // Which card on the contact record this field is rendered under.
    card: String(formData.get('card') ?? 'additional') as never,
  })

  if (error) {
    return {
      error: error.message.includes('duplicate key')
        ? `A "${key}" field already exists for that record type.`
        : error.message,
    }
  }

  revalidatePath('/settings/fields')
  return { ok: `${label} added.` }
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

export async function createTag(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'A tag needs a name' }

  const { error } = await scoped(context, 'tags').insert({
    name,
    color: String(formData.get('color') ?? '#64748b'),
  })

  if (error) {
    return {
      error: error.message.includes('duplicate key')
        ? `The tag "${name}" already exists.`
        : error.message,
    }
  }

  revalidatePath('/settings/tags')
  return { ok: `${name} added.` }
}

/**
 * Renames or recolours a tag, keeping everything attached to it.
 *
 * The alternative people were left with was deleting and re-adding, which
 * takes the tag off every record that carried it — a rename should not cost
 * you the segmentation you built with it. The rows in contact_tags,
 * company_tags and product_tags point at the id, so none of them move.
 */
export async function updateTag(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!id) return { error: 'Which tag?' }
  if (!name) return { error: 'A tag needs a name' }

  const { error } = await scoped(context, 'tags')
    .update({ name, color: String(formData.get('color') ?? '#64748b') })
    .eq('id', id)

  if (error) {
    return {
      error: error.message.includes('duplicate key')
        ? `The tag "${name}" already exists.`
        : error.message,
    }
  }

  // Every list that shows a tag name, not just the settings page.
  revalidatePath('/settings/tags')
  revalidatePath('/contacts')
  revalidatePath('/companies')
  revalidatePath('/products')
  return { ok: `Saved.` }
}

export async function deleteTag(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'tags').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/settings/tags')
}

/**
 * Creates a tag from wherever somebody is tagging, and hands it straight back.
 *
 * Tagging a record and defining a tag were two screens apart: you had to leave
 * what you were doing, go to Settings, add the tag, come back and find your
 * place. The name is all this asks for — the colour is picked from the palette
 * and can be changed in Settings, which is where colour belongs.
 *
 * Returns the existing tag when the name is already taken rather than failing.
 * Somebody typing a name that exists means the same thing either way, and an
 * error there would be the app being pedantic about something it can resolve.
 */
export async function createTagNamed(
  name: string,
): Promise<{ id: string; name: string; color: string }> {
  const context = await requireSession()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A tag needs a name')

  const { data: existing } = await scoped(context, 'tags')
    .select('id, name, color')
    .ilike('name', trimmed)
    .limit(1)
    .maybeSingle()

  if (existing) return existing as { id: string; name: string; color: string }

  const { data, error } = await scoped(context, 'tags')
    .insert({ name: trimmed, color: nextTagColor(trimmed) })
    .select('id, name, color')
    .single()

  if (error) throw new Error(error.message)

  revalidatePath('/settings/tags')
  return data as { id: string; name: string; color: string }
}

/**
 * A colour for a tag nobody chose one for.
 *
 * Derived from the name rather than random or sequential, so the same word
 * gets the same colour every time — including across two people creating it
 * at once, and in a preview before the row exists. All from the same palette
 * the option badges use, so a tag never arrives fluorescent.
 */
function nextTagColor(name: string): string {
  const palette = [
    '#0f766e',
    '#1d4ed8',
    '#b45309',
    '#be123c',
    '#7c3aed',
    '#0e7490',
    '#4d7c0f',
    '#a21caf',
  ]
  let hash = 0
  for (const character of name.toLowerCase()) hash = (hash * 31 + character.charCodeAt(0)) % 100000
  return palette[hash % palette.length]
}

// -----------------------------------------------------------------------------
// Organization settings (PRD 8.1, available early since it is trivial)
// -----------------------------------------------------------------------------

/** A currency code from the list, or the one already saved. */
function currencyOr(value: string, fallback: string): string {
  const code = value.trim().toUpperCase()
  return (CURRENCIES as readonly string[]).includes(code) ? code : fallback
}

export async function updateOrganization(formData: FormData) {
  const context = await requireAdmin()

  const { error } = await context.supabase
    .from('organizations')
    .update({
      name: String(formData.get('name') ?? '').trim() || context.organization.name,
      primary_color: String(formData.get('primary_color') ?? context.organization.primary_color),
      /*
       * Checked against the list rather than trusted. A currency code ends up
       * on printed documents and inside Intl.NumberFormat, and an unknown one
       * renders as a blank symbol rather than failing — so a typo would be
       * discovered by a customer.
       */
      default_currency: currencyOr(
        String(formData.get('default_currency') ?? ''),
        context.organization.default_currency,
      ),
      /*
       * Validated here as well as by the database's trigger, so a zone this
       * Node build cannot format is refused before it reaches a report and
       * throws mid-render rather than after being saved.
       */
      timezone: safeTimeZone(String(formData.get('timezone') ?? '')) ,
      logo_url: String(formData.get('logo_url') ?? '').trim() || null,
    })
    .eq('id', context.organizationId)

  if (error) throw new Error(error.message)
  revalidatePath('/', 'layout')
  revalidatePath('/settings/organization')
}

// -----------------------------------------------------------------------------
// Select field options
//
// The values behind Market, Customer type, Role type, Priority and
// Credibility, each with its own colour. An organization owns its own lists —
// editing one never touches another's.
// -----------------------------------------------------------------------------

/**
 * A refusal here is the administrator's to fix — the value is already on the
 * list, or blank — so it comes back as a message under the form rather than as
 * a thrown error. Throwing put the sentence naming the duplicate in the server
 * log, and an "Application error" digest in front of the person who had just
 * typed it.
 */
export async function createFieldOption(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireAdmin()

  const fieldKey = String(formData.get('field_key') ?? '')
  const entityType = String(formData.get('entity_type') ?? 'contact')
  const value = String(formData.get('value') ?? '').trim()
  const color = String(formData.get('color') ?? 'slate')

  // Either a built-in field, or a custom select this organization defined.
  const isBuiltIn = OPTION_FIELDS.some(
    (field) => field.key === fieldKey && field.entity === entityType,
  )
  if (!isBuiltIn) {
    const { data: definition } = await scoped(context, 'custom_field_definitions')
      .select('id')
      .eq('entity_type', entityType)
      .eq('key', fieldKey)
      .in('field_type', ['select', 'multiselect'])
      .limit(1)

    if (((definition ?? []) as unknown[]).length === 0) {
      return { error: 'That field no longer exists — reload the page.' }
    }
  }

  if (!value) return { error: 'An option needs a value' }
  if (!OPTION_COLORS.includes(color as OptionColor)) return { error: 'Unknown colour' }

  // Appended to the end of its own list.
  const { data: existing } = await scoped(context, 'field_options')
    .select('order')
    .eq('field_key', fieldKey)
    .eq('entity_type', entityType)
    .order('order', { ascending: false })
    .limit(1)

  const nextOrder = ((existing ?? []) as { order: number }[])[0]?.order ?? 0

  const { error } = await scoped(context, 'field_options').insert({
    field_key: fieldKey,
    entity_type: entityType as never,
    value,
    color: color as never,
    order: nextOrder + 1,
  })

  if (error) {
    return {
      error: error.message.includes('duplicate key')
        ? `"${value}" is already an option for that field.`
        : error.message,
    }
  }

  revalidatePath('/settings/fields')
  return { ok: `"${value}" added.` }
}

export async function updateFieldOptionColor(formData: FormData) {
  const context = await requireAdmin()

  const id = String(formData.get('id') ?? '')
  const color = String(formData.get('color') ?? '')
  if (!OPTION_COLORS.includes(color as OptionColor)) throw new Error('Unknown colour')

  const { error } = await scoped(context, 'field_options')
    .update({ color: color as never })
    .eq('id', id)

  if (error) throw new Error(error.message)
  revalidatePath('/settings/fields')
}

/**
 * Deleting an option leaves it on any contact already holding it: the value is
 * stored on the record, not as a foreign key. Those contacts keep showing the
 * old value in a neutral colour until they are edited, which is better than
 * silently rewriting history.
 */
export async function deleteFieldOption(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'field_options').delete().eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/settings/fields')
}

// -----------------------------------------------------------------------------
// Restoring deleted records
//
// Only an administrator sees the recycle bin, and only an administrator can put
// something back. The database enforces that too — these are thin wrappers.
// -----------------------------------------------------------------------------

export async function restoreContact(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('restore_contact', { p_contact_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/settings/deleted')
  revalidatePath('/contacts')
}

export async function restoreCompany(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('restore_company', { p_company_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/settings/deleted')
  revalidatePath('/companies')
}

export async function restoreDeal(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('restore_deal', { p_deal_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/settings/deleted')
  revalidatePath('/deals')
  // A restored deal commits its line items again, so the catalogue's numbers
  // change with it.
  revalidatePath('/products')
}

export async function restoreProduct(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('restore_product', { p_product_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/settings/deleted')
  revalidatePath('/products')
}

// -----------------------------------------------------------------------------
// Warehouses and bins
//
// The catalogue's own reference data: everyone reads it, managers arrange it.
// The RLS policies say so too, so these actions are the convenient path rather
// than the enforcing one.
// -----------------------------------------------------------------------------

export async function createStockLocation(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  assertCanManage(context)

  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'A location needs a name' }

  const { error } = await scoped(context, 'stock_locations').insert({
    name,
    code: String(formData.get('code') ?? '').trim() || null,
    address: String(formData.get('address') ?? '').trim() || null,
    created_by: context.user.id,
  })

  if (error) {
    return {
      error: error.message.includes('duplicate key')
        ? `There is already a location called "${name}".`
        : error.message,
    }
  }

  revalidatePath('/settings/locations')
  return { ok: `${name} added.` }
}

/**
 * Retires a location, or brings it back.
 *
 * Not a delete: stock_levels references it with `on delete restrict`, precisely
 * so that removing a warehouse can never quietly destroy the record of what was
 * counted in it. A retired location keeps its history and leaves the pickers.
 */
export async function setStockLocationActive(formData: FormData) {
  const context = await requireSession()
  assertCanManage(context)

  const { error } = await scoped(context, 'stock_locations')
    .update({ active: formData.get('active') === 'true' })
    .eq('id', String(formData.get('id') ?? ''))

  if (error) throw new Error(error.message)
  revalidatePath('/settings/locations')
}

export async function createStockBin(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireSession()
  assertCanManage(context)

  const locationId = String(formData.get('location_id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!locationId || !name) return { error: 'A bin needs a location and a name' }

  const { error } = await scoped(context, 'stock_bins').insert({ location_id: locationId, name })

  if (error) {
    return {
      error: error.message.includes('duplicate key')
        ? `That location already has a bin called "${name}".`
        : error.message,
    }
  }

  revalidatePath('/settings/locations')
  return { ok: `${name} added.` }
}

/**
 * Deletes a bin.
 *
 * Safe to delete outright where a location is not: stock_levels.bin_id is
 * `on delete set null`, so the stock stays where it is and simply stops naming
 * a shelf. Nothing is lost but the shelf.
 */
export async function deleteStockBin(formData: FormData) {
  const context = await requireSession()
  assertCanManage(context)

  const { error } = await scoped(context, 'stock_bins')
    .delete()
    .eq('id', String(formData.get('id') ?? ''))

  if (error) throw new Error(error.message)
  revalidatePath('/settings/locations')
}

/**
 * Brings a deleted sales order back.
 *
 * The order's lines come with it — they were never deleted, only made
 * unreachable — so a restored order is worth exactly what it was worth.
 */
export async function restoreSalesOrder(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('restore_sales_order', { p_sales_order_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/settings/deleted')
  revalidatePath('/sales-orders')
}
