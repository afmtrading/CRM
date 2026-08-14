import 'server-only'

import { cache } from 'react'
import { redirect } from 'next/navigation'

import { createSupabaseServerClient } from '@/lib/supabase/server'
import type { OrganizationRow, UserRow } from '@/lib/database.types'

export interface SessionContext {
  authUserId: string
  user: UserRow
  organization: OrganizationRow
  organizationId: string
  isAdmin: boolean
  /** Admin or manager: sees every record in the organization. */
  canManage: boolean
  /** Admin, manager or sales director: may import, export and reassign. */
  canBulk: boolean
  /** Anyone but a read-only user. */
  canWrite: boolean
  /**
   * May edit permission sets and assign people to them.
   *
   * Deliberately not implied by isAdmin: without the separation, anybody who
   * can reach Settings can grant themselves anything, which makes every other
   * capability advisory.
   */
  canManagePermissions: boolean
  /**
   * Sees hidden contacts and companies, and may hide or unhide them.
   *
   * No fallback to a role, unlike the others: before this existed nothing could
   * be hidden, so the honest answer when no set resolves is false. Falling back
   * to "administrator" would show hidden records to every admin the moment a
   * seed went missing.
   */
  canSeeHidden: boolean
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>
}

/**
 * Resolves the signed-in person to exactly one organization (PRD 6.1).
 *
 * Every server component and route handler in the app starts here. It is
 * request-cached, so the extra round trips happen once per request rather than
 * once per component.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const supabase = await createSupabaseServerClient()

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (!authUser) return null

  // Read through RLS: this returns the caller's own user row only.
  const { data: userRow } = await supabase
    .from('users')
    .select('*')
    .eq('auth_provider_id', authUser.id)
    .eq('status', 'active')
    .order('created_at')
    .limit(1)
    .maybeSingle()

  if (!userRow) return null

  /*
   * The organization and the caller's capabilities, together: the second is a
   * round trip that would otherwise be a third one in sequence, and neither
   * depends on the other.
   *
   * current_permissions() is the same function the row-level policies consult,
   * so the interface and the database are reading one source rather than two
   * copies of the same rules. They used to be two copies — the booleans below
   * were derived from the role here and from a hardcoded list in the database,
   * and would have parted company the first time anybody edited a set.
   */
  const [{ data: organization }, { data: permissions }] = await Promise.all([
    supabase.from('organizations').select('*').eq('id', userRow.organization_id).single(),
    supabase.rpc('current_permissions'),
  ])

  if (!organization) return null

  /*
   * The fallbacks mirror the ones inside the database helpers, and fire in the
   * same circumstance: an organization with no permission sets at all, which
   * the seed and its trigger between them should make impossible. Degrading to
   * the old role rule beats degrading to nothing, which for an administrator
   * would mean being locked out of the screen they would need to fix it.
   *
   * The database is still what enforces all of this. These exist so the
   * interface does not offer a button that RLS will refuse; if the two ever
   * disagree, the database wins and the user sees a failure rather than a
   * breach.
   */
  return {
    authUserId: authUser.id,
    user: userRow,
    organization,
    organizationId: organization.id,
    isAdmin: permissions?.administer ?? userRow.role === 'admin',
    canManage:
      permissions?.manage_records ?? (userRow.role === 'admin' || userRow.role === 'manager'),
    canBulk:
      permissions?.bulk_records ??
      (userRow.role === 'admin' ||
        userRow.role === 'manager' ||
        userRow.role === 'sales_director'),
    canWrite: permissions?.write_records ?? userRow.role !== 'readonly',
    canManagePermissions: permissions?.manage_permissions ?? userRow.role === 'admin',
    canSeeHidden: permissions?.see_hidden ?? false,
    supabase,
  }
})

/** The Supabase Auth user, independent of whether a CRM record exists for them. */
export const getAuthUser = cache(async () => {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
})

/**
 * Same as getSessionContext, but for pages and actions that cannot proceed
 * without one.
 *
 * Someone can hold a valid Supabase session and still have no CRM user row —
 * they authenticated but no admin has provisioned them into an organization.
 * They go to /no-access rather than /login, which would bounce them straight
 * back here.
 */
export async function requireSession(): Promise<SessionContext> {
  const context = await getSessionContext()
  if (context) return context

  const authUser = await getAuthUser()
  redirect(authUser ? '/no-access' : '/login')
}

export async function requireAdmin(): Promise<SessionContext> {
  const context = await requireSession()
  if (!context.isAdmin) redirect('/?error=admin-required')
  return context
}

/** For pages behind the bulk tools — import, export. */
export async function requireBulk(): Promise<SessionContext> {
  const context = await requireSession()
  if (!context.canBulk) redirect('/?error=permission')
  return context
}

/** Guards a server action. Throws rather than redirects, so the form reports it. */
export function assertCanWrite(context: SessionContext) {
  if (!context.canWrite) throw new Error('Your role does not allow changes.')
}

export function assertCanManage(context: SessionContext) {
  if (!context.canManage) throw new Error('Only an administrator or manager can do that.')
}

export function assertCanBulk(context: SessionContext) {
  if (!context.canBulk) throw new Error('Your role does not allow importing, exporting or assigning.')
}

/**
 * Types the result of a single-row query.
 *
 * `const deal = await firstRow<DealRow>(scoped(ctx, 'deals').select('*').eq('id', id).maybeSingle())`
 *
 * The query builder is untyped by design (see lib/supabase/server.ts), so this
 * is where a row gets its shape back.
 */
export async function firstRow<T>(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T | null> {
  const { data } = await query
  return (data as T | null) ?? null
}

/** Tables that carry organization_id and must always be queried through scoped(). */
export type TenantTable =
  | 'contacts'
  | 'companies'
  | 'pipelines'
  | 'stages'
  | 'deals'
  | 'products'
  | 'deal_products'
  | 'contact_products'
  | 'sales_orders'
  | 'sales_order_lines'
  | 'sales_order_payments'
  | 'invoices'
  | 'invoice_lines'
  | 'invoice_payments'
  | 'stock_locations'
  | 'stock_bins'
  | 'stock_levels'
  | 'stock_adjustments'
  | 'activities'
  | 'tags'
  | 'contact_tags'
  | 'company_tags'
  | 'saved_filters'
  | 'import_jobs'
  | 'import_profiles'
  | 'lead_score_rules'
  | 'assignment_rules'
  | 'custom_field_definitions'
  | 'field_options'
  | 'notifications'
  | 'permission_sets'
  | 'mailbox_connections'
  | 'sending_domains'
  | 'email_suppressions'
  | 'email_lists'
  | 'email_list_members'
  | 'campaigns'
  | 'campaign_recipients'
  /* A view rather than a table, but it carries organization_id and reads
     through the caller's own policies, so it scopes exactly like one. */
  | 'contact_mailability'
  | 'users'

/**
 * The application layer of the tenancy rule (PRD Section 2).
 *
 * `scoped(ctx, 'contacts').select(...)` is the only sanctioned way to read a
 * tenant table: the organization filter is applied before the caller gets the
 * builder, so it cannot be forgotten. RLS enforces the same thing underneath —
 * this layer exists so a bug is a bug in one place, not a data leak.
 */
export function scoped(context: SessionContext, table: TenantTable) {
  return {
    select: (columns = '*', options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) =>
      context.supabase
        .from(table)
        .select(columns, options)
        .eq('organization_id', context.organizationId),

    insert: <T extends Record<string, unknown>>(values: T | T[]) => {
      const withOrg = Array.isArray(values)
        ? values.map((v) => ({ ...v, organization_id: context.organizationId }))
        : { ...values, organization_id: context.organizationId }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return context.supabase.from(table).insert(withOrg as any)
    },

    update: <T extends Record<string, unknown>>(values: T) =>
      context.supabase
        .from(table)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(values as any)
        .eq('organization_id', context.organizationId),

    upsert: <T extends Record<string, unknown>>(
      values: T | T[],
      options?: { onConflict?: string },
    ) => {
      const withOrg = Array.isArray(values)
        ? values.map((v) => ({ ...v, organization_id: context.organizationId }))
        : { ...values, organization_id: context.organizationId }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return context.supabase.from(table).upsert(withOrg as any, options)
    },

    delete: () =>
      context.supabase.from(table).delete().eq('organization_id', context.organizationId),
  }
}
