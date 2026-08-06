import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getSessionContext, scoped, firstRow } from '@/lib/tenancy'
import { importFieldsFor, mapRow, toContactPayload, type FieldMapping } from '@/lib/csv'
import type { FilterEntityType } from '@/lib/database.types'

/**
 * POST /imports — start an ImportJob (PRD Section 9, 6.7).
 *
 * Rows are validated one at a time and failures are recorded per row, so a bad
 * row never takes the batch down with it. The response is the job record,
 * including the per-row error list; GET /imports/{id} returns the same shape.
 */

const requestSchema = z.object({
  entity_type: z.enum(['contact', 'company']).default('contact'),
  file_name: z.string().max(400).default(''),
  mapping: z.record(z.string()),
  rows: z.array(z.record(z.string())).max(20_000),
  options: z
    .object({
      // What to do when an incoming row matches an existing contact's email.
      on_duplicate: z.enum(['skip', 'update', 'create']).default('skip'),
      create_missing_companies: z.boolean().default(true),
    })
    .default({ on_duplicate: 'skip', create_missing_companies: true }),
})

interface RowError {
  row: number
  errors: string[]
  values?: Record<string, string>
}

export async function POST(request: Request) {
  const context = await getSessionContext()
  if (!context) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const parsed = requestSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 })
  }

  const { entity_type: entityType, file_name: fileName, mapping, rows, options } = parsed.data

  const { data: job, error: jobError } = await scoped(context, 'import_jobs')
    .insert({
      user_id: context.user.id,
      entity_type: entityType as FilterEntityType,
      status: 'processing',
      file_name: fileName,
      field_mapping: mapping,
      options,
    })
    .select('*')
    .single()

  if (jobError) {
    return NextResponse.json({ error: jobError.message }, { status: 500 })
  }

  const fields = importFieldsFor(entityType as FilterEntityType)
  const errors: RowError[] = []
  let processed = 0

  // Company lookup cache, so a 5,000-row file with 40 companies does 40 reads.
  const companyIds = new Map<string, string>()
  const tagIds = new Map<string, string>()

  async function resolveCompany(name: string): Promise<string | null> {
    const key = name.trim().toLowerCase()
    if (!key) return null
    if (companyIds.has(key)) return companyIds.get(key)!

    const existing = await firstRow<{ id: string }>(
      scoped(context!, 'companies').select('id').ilike('name', name.trim()).limit(1).maybeSingle(),
    )

    if (existing) {
      companyIds.set(key, existing.id)
      return existing.id
    }

    if (!options.create_missing_companies) return null

    const { data: created } = await scoped(context!, 'companies')
      .insert({ name: name.trim(), owner_id: context!.user.id })
      .select('id')
      .single()

    if (created) companyIds.set(key, created.id)
    return created?.id ?? null
  }

  async function resolveTag(name: string): Promise<string | null> {
    const key = name.trim().toLowerCase()
    if (!key) return null
    if (tagIds.has(key)) return tagIds.get(key)!

    const existing = await firstRow<{ id: string }>(
      scoped(context!, 'tags').select('id').ilike('name', name.trim()).limit(1).maybeSingle(),
    )

    if (existing) {
      tagIds.set(key, existing.id)
      return existing.id
    }

    const { data: created } = await scoped(context!, 'tags')
      .insert({ name: name.trim() })
      .select('id')
      .single()

    if (created) tagIds.set(key, created.id)
    return created?.id ?? null
  }

  for (const [index, raw] of rows.entries()) {
    const rowNumber = index + 2 // +1 for the header row, +1 for 1-based counting
    const mapped = mapRow(raw, mapping as FieldMapping, fields, rowNumber)

    if (mapped.errors.length > 0) {
      errors.push({ row: rowNumber, errors: mapped.errors, values: mapped.values })
      continue
    }

    try {
      if (entityType === 'company') {
        const { error } = await scoped(context, 'companies').insert({
          name: mapped.values.name,
          domain: mapped.values.domain ?? null,
          industry: mapped.values.industry ?? null,
          owner_id: context.user.id,
          custom_fields: mapped.customFields,
        })
        if (error) throw new Error(error.message)
        processed += 1
        continue
      }

      const payload = toContactPayload(mapped)

      // Deduplication at import time (PRD 6.7).
      let existingId: string | null = null
      if (payload.email) {
        const existing = await firstRow<{ id: string }>(
          scoped(context, 'contacts')
            .select('id')
            .ilike('email', payload.email)
            .is('duplicate_of_id', null)
            .limit(1)
            .maybeSingle(),
        )
        existingId = existing?.id ?? null
      }

      if (existingId && options.on_duplicate === 'skip') {
        errors.push({
          row: rowNumber,
          errors: [`Skipped: ${payload.email} already exists in this organization`],
          values: mapped.values,
        })
        continue
      }

      const companyId = payload.company_name ? await resolveCompany(payload.company_name) : null

      const record = {
        first_name: payload.first_name,
        last_name: payload.last_name,
        email: payload.email,
        phone: payload.phone,
        lifecycle_stage: payload.lifecycle_stage,
        source: payload.source,
        custom_fields: payload.custom_fields,
        ...(companyId ? { company_id: companyId } : {}),
      }

      let contactId: string

      if (existingId && options.on_duplicate === 'update') {
        const { error } = await scoped(context, 'contacts').update(record).eq('id', existingId)
        if (error) throw new Error(error.message)
        contactId = existingId
      } else {
        // Routing rules pick the owner when the file does not name one (6.5).
        const { data: assignee } = await context.supabase.rpc('next_assignee', {
          p_source: payload.source,
        })

        const { data: created, error } = await scoped(context, 'contacts')
          .insert({ ...record, owner_id: assignee ?? context.user.id })
          .select('id')
          .single()

        if (error) throw new Error(error.message)
        contactId = created.id
      }

      for (const tagName of payload.tags) {
        const tagId = await resolveTag(tagName)
        if (tagId) {
          await scoped(context, 'contact_tags').upsert(
            { contact_id: contactId, tag_id: tagId },
            { onConflict: 'contact_id,tag_id' },
          )
        }
      }

      processed += 1
    } catch (error) {
      errors.push({
        row: rowNumber,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
        values: mapped.values,
      })
    }
  }

  const { data: finished } = await scoped(context, 'import_jobs')
    .update({
      status: 'complete',
      rows_processed: processed,
      rows_failed: errors.length,
      errors,
      completed_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .select('*')
    .single()

  return NextResponse.json({ job: finished ?? job })
}

/** GET /imports — recent jobs for this organization. */
export async function GET() {
  const context = await getSessionContext()
  if (!context) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data } = await scoped(context, 'import_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20)

  return NextResponse.json({ jobs: data ?? [] })
}
