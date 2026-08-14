'use server'

import { revalidatePath } from 'next/cache'

import { requireBulk, scoped } from '@/lib/tenancy'
import { buildPlan, type ImportPlan, type PlannedCompany } from '@/lib/import-plan'
import { writableChanges, type CountryLookup, type MatchCandidate } from '@/lib/import-analysis'

/**
 * Planning and applying a buyer-list import.
 *
 * Two calls, and the split is the point. `planImport` reads the file and says
 * what it would do; `applyImport` does exactly that and nothing else. Both run
 * the same pure functions from lib/import-plan, so the review screen is a
 * statement about what will happen rather than an estimate of it.
 *
 * Behind requireBulk, which is the capability that already governs import and
 * export. Nothing here bypasses row-level security — every write goes through
 * the caller's own client, so an import cannot reach further than the person
 * running it.
 */

export interface PlanInput {
  rows: { rowNumber: number; values: Record<string, string> }[]
  mapping: Record<string, string>
  /** Values in the contact-name column that are not people. */
  placeholders: string[]
}

export async function planImport(input: PlanInput): Promise<ImportPlan> {
  const context = await requireBulk()

  const [{ data: countries }, { data: subdivisions }, { data: existing }] = await Promise.all([
    context.supabase.from('countries').select('code, name'),
    context.supabase.from('country_subdivisions').select('code, country_code'),
    /*
     * Every company in the organization, because matching is by domain, email
     * and name and the file gives no ids to narrow by. Two hundred rows against
     * a few thousand companies is a table scan the database does in
     * milliseconds, and doing it once beats a query per row.
     */
    scoped(context, 'companies')
      .select('id, name, domain, email, based_in, based_in_region, phone, notes, specialty_market, stock_type, customer_type, sells_in, sources_in')
      .is('deleted_at', null),
  ])

  return buildPlan(
    input.rows,
    input.mapping,
    {
      countries: (countries ?? []) as CountryLookup[],
      subdivisions: (subdivisions ?? []) as { code: string; country_code: string }[],
      placeholders: new Set(input.placeholders),
    },
    (existing ?? []) as MatchCandidate[],
  )
}

export interface ApplyInput extends PlanInput {
  /** The companies to act on, by key. Everything else in the plan is skipped. */
  approved: string[]
  /** Whether a change that would overwrite an existing value is allowed through. */
  allowReplace: boolean
}

export interface ApplyResult {
  companiesCreated: number
  companiesUpdated: number
  contactsCreated: number
  contactsSkipped: number
  errors: { company: string; message: string }[]
}

/**
 * Writes the approved part of the plan.
 *
 * The plan is rebuilt here rather than accepted from the browser. What arrives
 * is the file and the mapping — the same inputs the preview was built from —
 * so a tampered plan cannot ask for a write the preview never showed. It also
 * means the matching is re-run against the database as it is now rather than as
 * it was when the preview was drawn.
 */
export async function applyImport(input: ApplyInput): Promise<ApplyResult> {
  const context = await requireBulk()

  const plan = await planImport(input)
  const approved = new Set(input.approved)
  const result: ApplyResult = {
    companiesCreated: 0,
    companiesUpdated: 0,
    contactsCreated: 0,
    contactsSkipped: 0,
    errors: [],
  }

  for (const company of plan.companies) {
    if (!approved.has(company.key)) continue

    try {
      const companyId = await writeCompany(context, company, input.allowReplace, result)
      if (!companyId) continue
      await writeContacts(context, company, companyId, result)
    } catch (error) {
      result.errors.push({
        company: company.name,
        message: error instanceof Error ? error.message : 'Could not be saved',
      })
    }
  }

  revalidatePath('/companies')
  revalidatePath('/contacts')
  return result
}

type Context = Awaited<ReturnType<typeof requireBulk>>

async function writeCompany(
  context: Context,
  company: PlannedCompany,
  allowReplace: boolean,
  result: ApplyResult,
): Promise<string | null> {
  if (!company.matchId) {
    const { data, error } = await scoped(context, 'companies')
      .insert(company.values as never)
      .select('id')
      .single()

    if (error) throw new Error(error.message)
    result.companiesCreated += 1
    return (data as { id: string }).id
  }

  /*
   * Only the fields that would actually change, and — unless it was explicitly
   * allowed — only the ones filling a blank. Sending the whole record would
   * overwrite by accident whatever the file happens not to know about, which is
   * the failure this whole design exists to prevent.
   */
  const changes = writableChanges(company.changes).filter(
    (change) => allowReplace || change.kind === 'fill',
  )

  if (changes.length === 0) return company.matchId

  const patch = Object.fromEntries(changes.map((change) => [change.field, change.after]))
  const { error } = await scoped(context, 'companies')
    .update(patch as never)
    .eq('id', company.matchId)

  if (error) throw new Error(error.message)
  result.companiesUpdated += 1
  return company.matchId
}

async function writeContacts(
  context: Context,
  company: PlannedCompany,
  companyId: string,
  result: ApplyResult,
): Promise<void> {
  for (const contact of company.contacts) {
    const email = (contact.values.email as string | undefined)?.trim().toLowerCase()

    // A contact already on file is left alone rather than duplicated. Updating
    // people as well as companies is a bigger decision than this screen is
    // asking for, and doubling somebody's contact list is not recoverable in
    // one action.
    if (email) {
      const { data: seen } = await scoped(context, 'contacts')
        .select('id')
        .eq('email', email)
        .limit(1)
        .maybeSingle()

      if (seen) {
        result.contactsSkipped += 1
        continue
      }
    }

    const { error } = await scoped(context, 'contacts').insert({
      ...(contact.values as Record<string, unknown>),
      company_id: companyId,
    } as never)

    if (error) throw new Error(error.message)
    result.contactsCreated += 1
  }
}
