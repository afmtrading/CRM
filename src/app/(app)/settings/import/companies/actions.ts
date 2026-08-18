'use server'

import { revalidatePath } from 'next/cache'

import { requireBulk, scoped } from '@/lib/tenancy'
import { buildPlan, importTargets, type ImportPlan, type PlannedCompany } from '@/lib/import-plan'
import { writableChanges, type CountryLookup, type MatchCandidate } from '@/lib/import-analysis'
import { applyMerges, proposeOptions, type OptionProposal } from '@/lib/import-vocabulary'
import { OPTION_FIELDS } from '@/lib/field-options'
import type { FieldOptionRow, ImportProfileRow } from '@/lib/database.types'

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
  /** Per option field, spelling to spelling. Applied before anything is counted. */
  valueMerges?: Record<string, Record<string, string>>
}

/** The three option lists a buyer list can add to. */
const OPTION_TARGETS: { target: string; field: string }[] = [
  { target: 'company.specialty_market', field: 'specialty_market' },
  { target: 'company.stock_type', field: 'stock_type' },
  { target: 'company.customer_type', field: 'customer_type' },
  /*
   * Single-valued, unlike the three above, and here for the same reason they
   * are: a list that still says "Standard" where the option list now says
   * "Medium" should be offered the correction once and have it remembered,
   * rather than quietly writing a value no filter will ever match.
   */
  { target: 'company.priority', field: 'priority' },
]

export interface PlanResult {
  plan: ImportPlan
  /** Values in the file that your option lists do not have yet. */
  proposals: OptionProposal[]
}

export async function planImport(input: PlanInput): Promise<PlanResult> {
  const context = await requireBulk()

  const [
    { data: countries },
    { data: existing },
    { data: options },
    { data: users },
    { data: definitions },
  ] = await Promise.all([
    context.supabase.from('countries').select('code, name'),
    /*
     * Every company in the organization, because matching is by domain, email
     * and name and the file gives no ids to narrow by. Two hundred rows against
     * a few thousand companies is a table scan the database does in
     * milliseconds, and doing it once beats a query per row.
     */
      scoped(context, 'companies')
        .select('id, name, domain, email, based_in, phone, notes, specialty_market, stock_type, customer_type, sells_in')
        .is('deleted_at', null),
      scoped(context, 'field_options').select('field_key, value'),
      // For an owner column, which arrives as "Emile" rather than as a uuid.
      scoped(context, 'users').select('id, name, email').eq('status', 'active'),
      // So a field this organization defined for itself can be mapped to.
      scoped(context, 'custom_field_definitions').select('key, label, entity_type'),
    ])

  const customFields = (definitions ?? []) as { key: string; label: string; entity_type: string }[]

  /*
   * Merges are applied to the cells before anything reads them, so the plan,
   * the counts and the proposals all see the corrected vocabulary. Doing it
   * afterwards would mean the review screen offering to add "PLATFORM" as a new
   * option immediately after somebody had said it means "Marketplace".
   */
  const merges = input.valueMerges ?? {}
  const rows = Object.keys(merges).length > 0 ? mergeCells(input.rows, input.mapping, merges) : input.rows

  const plan = buildPlan(
    rows,
    input.mapping,
    {
      countries: (countries ?? []) as CountryLookup[],
      placeholders: new Set(input.placeholders),
      users: (users ?? []) as { id: string; name: string; email: string }[],
      targets: importTargets(customFields),
    },
    (existing ?? []) as MatchCandidate[],
  )

  const existingOptions = (options ?? []) as Pick<FieldOptionRow, 'field_key' | 'value'>[]

  const proposals = OPTION_TARGETS.filter(({ target }) =>
    Object.values(input.mapping).includes(target),
  ).map(({ target, field }) => {
    const values = plan.companies.flatMap((company) => {
      // Most of these columns hold a list; priority holds one value. Both end
      // up as a list of what the file said, which is all proposeOptions wants.
      const held = company.values[target.split('.')[1]]
      if (Array.isArray(held)) return held as string[]
      return typeof held === 'string' && held ? [held] : []
    })
    return proposeOptions(
      field,
      OPTION_FIELDS.find((option) => option.key === field)?.label ?? field,
      values,
      existingOptions.filter((option) => option.field_key === field).map((option) => option.value),
    )
  }).filter((proposal) => proposal.missing.length > 0)

  return { plan, proposals }
}

/** Rewrites the cells of every option-mapped column through the merge table. */
function mergeCells(
  rows: PlanInput['rows'],
  mapping: Record<string, string>,
  merges: Record<string, Record<string, string>>,
): PlanInput['rows'] {
  const byHeader = new Map<string, Record<string, string>>()
  for (const { target, field } of OPTION_TARGETS) {
    const header = Object.keys(mapping).find((key) => mapping[key] === target)
    if (header && merges[field]) byHeader.set(header, merges[field])
  }
  if (byHeader.size === 0) return rows

  return rows.map((row) => ({
    ...row,
    values: Object.fromEntries(
      Object.entries(row.values).map(([header, value]) => {
        const table = byHeader.get(header)
        if (!table || !value.trim()) return [header, value]
        // Rejoined with a pipe, which splitValues treats as a separator, so a
        // merged multi-value cell stays multi-valued.
        return [header, applyMerges(value.split(/[|/,]/), table).join(' | ')]
      }),
    ),
  }))
}

/** The profile for this shape of file, if this organization has seen it before. */
export async function findProfile(signature: string): Promise<ImportProfileRow | null> {
  const context = await requireBulk()

  const { data } = await scoped(context, 'import_profiles')
    .select('*')
    .eq('signature', signature)
    .maybeSingle()

  return (data as ImportProfileRow | null) ?? null
}

export async function saveProfile(input: {
  name: string
  signature: string
  headers: string[]
  mapping: Record<string, string>
  valueMerges: Record<string, Record<string, string>>
  placeholders: string[]
}): Promise<void> {
  const context = await requireBulk()

  const { error } = await context.supabase.rpc('save_import_profile', {
    p_name: input.name,
    p_signature: input.signature,
    p_headers: input.headers,
    p_mapping: input.mapping,
    p_value_merges: input.valueMerges,
    p_placeholders: input.placeholders,
  })

  if (error) throw new Error(error.message)
  revalidatePath('/settings/import/companies')
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

  const { plan } = await planImport(input)
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

    const id = (data as { id: string }).id
    if (company.tags.length > 0) await attachTags(context, 'company', id, company.tags)
    return id
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

  // Tags are added whether or not a column changed: a file whose only new
  // information is a tag still carries information.
  if (company.tags.length > 0) {
    await attachTags(context, 'company', company.matchId, company.tags)
  }

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

    const { data, error } = await scoped(context, 'contacts')
      .insert({
        ...(contact.values as Record<string, unknown>),
        company_id: companyId,
      } as never)
      .select('id')
      .single()

    if (error) throw new Error(error.message)
    result.contactsCreated += 1

    if (contact.tags.length > 0) {
      await attachTags(context, 'contact', (data as { id: string }).id, contact.tags)
    }
  }
}

/**
 * Attaches tag names to a record, creating the ones this organization does not
 * have yet.
 *
 * Created rather than refused, because a tag is the organization's own word and
 * a list arriving with a word they have not typed into Settings yet is the
 * ordinary case, not an error. Matched case-insensitively so "Orthotics" and
 * "orthotics" stay one tag rather than becoming two.
 */
async function attachTags(
  context: Context,
  entity: 'company' | 'contact',
  recordId: string,
  names: string[],
): Promise<void> {
  const { data: existing } = await scoped(context, 'tags').select('id, name')
  const byName = new Map(
    ((existing ?? []) as { id: string; name: string }[]).map((tag) => [
      tag.name.trim().toLowerCase(),
      tag.id,
    ]),
  )

  const ids: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (!name) continue

    const known = byName.get(name.toLowerCase())
    if (known) {
      ids.push(known)
      continue
    }

    const { data: made } = await scoped(context, 'tags')
      .insert({ name } as never)
      .select('id')
      .single()

    if (made) {
      const id = (made as { id: string }).id
      byName.set(name.toLowerCase(), id)
      ids.push(id)
    }
  }

  if (ids.length === 0) return

  /*
   * Added, never replaced.
   *
   * The obvious call here is syncTags, and it would be wrong: it makes a
   * record's tags exactly what it is handed, which for a file that mentions
   * one tag would strip every other tag the record already carries. An import
   * says what it knows, not what is true of everything else.
   */
  const { table, column } =
    entity === 'company'
      ? ({ table: 'company_tags', column: 'company_id' } as const)
      : ({ table: 'contact_tags', column: 'contact_id' } as const)

  await scoped(context, table).upsert(
    ids.map((tagId) => ({ [column]: recordId, tag_id: tagId })),
    { onConflict: `${column},tag_id` },
  )
}
