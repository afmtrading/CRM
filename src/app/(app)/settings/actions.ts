'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireAdmin, requireSession, scoped, firstRow } from '@/lib/tenancy'
import { createSupabaseAdminClient } from '@/lib/supabase/server'
import { siteUrl } from '@/lib/env'
import { OPTION_COLORS, OPTION_FIELDS } from '@/lib/field-options'
import { resolveStatus, wouldRemoveLastAdmin, type UserSnapshot } from '@/lib/users'
import type { OptionColor } from '@/lib/database.types'

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

/**
 * Renames a pipeline.
 *
 * A pipeline's name is a label on the board, not a key: deals point at stages,
 * and stages at the pipeline's id, so nothing breaks when it changes. Which is
 * exactly why it should be editable — "Trading desk" outliving the desk is
 * silly when the fix is one word.
 */
export async function renamePipeline(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()

  if (!name) throw new Error('A pipeline needs a name')
  if (name.length > 120) throw new Error('That name is too long')

  const { error } = await scoped(context, 'pipelines').update({ name }).eq('id', id)
  if (error) throw new Error(error.message)

  revalidatePath('/settings/pipelines')
  // The board and its picker are named from this too.
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
    // Which card on the contact record this field is rendered under.
    card: String(formData.get('card') ?? 'additional') as never,
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

// -----------------------------------------------------------------------------
// Select field options
//
// The values behind Specialty market, Customer type, Role type, Priority and
// Credibility, each with its own colour. An organization owns its own lists —
// editing one never touches another's.
// -----------------------------------------------------------------------------

export async function createFieldOption(formData: FormData) {
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

    if (((definition ?? []) as unknown[]).length === 0) throw new Error('Unknown field')
  }

  if (!value) throw new Error('An option needs a value')
  if (!OPTION_COLORS.includes(color as OptionColor)) throw new Error('Unknown colour')

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
    throw new Error(
      error.message.includes('duplicate key')
        ? `"${value}" is already an option for that field.`
        : error.message,
    )
  }

  revalidatePath('/settings/fields')
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

export async function restoreProduct(formData: FormData) {
  const context = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('restore_product', { p_product_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/settings/deleted')
  revalidatePath('/products')
}
