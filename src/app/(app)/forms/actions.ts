'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { firstRow, requireSession, scoped } from '@/lib/tenancy'
import type { ActionState } from '@/components/action-form'
import type { MarketingFormRow } from '@/lib/database.types'
import { parseFields, suggestSlug, whyNotPublishable, type FormField } from '@/lib/forms'

/**
 * Building a form, from the CRM side.
 *
 * The database is what decides whether a form is fit to publish — the trigger
 * on marketing_forms is the only rule both the public renderer and the submit
 * function sit behind. These actions check the same things first so the answer
 * arrives in the builder's language, and let anything they miss come back from
 * Postgres rather than pretending to be the authority.
 */

/** Postgres's unique-violation code, which here only ever means the slug. */
const UNIQUE_VIOLATION = '23505'

/**
 * What a new form starts as.
 *
 * Not an empty canvas. A form with no questions cannot be published, and the
 * four below are the ones almost every capture form has — so the first thing
 * somebody sees is a form they could publish, and editing beats composing.
 */
function startingQuestions(): FormField[] {
  return [
    { key: 'name', label: 'Your name', type: 'text', required: true, maps_to: 'full_name' },
    { key: 'email', label: 'Email address', type: 'email', required: true, maps_to: 'email' },
    { key: 'company', label: 'Company', type: 'text', required: false, maps_to: 'company_name' },
    {
      key: 'message',
      label: 'What are you looking for?',
      type: 'textarea',
      required: false,
      maps_to: 'notes',
    },
  ]
}

export async function createForm(_state: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireSession()
  if (!context.canWrite) return { error: 'Your role does not allow creating forms.' }

  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Give the form a name — something you will recognise in this list.' }
  if (name.length > 160) return { error: 'That name is too long.' }

  const { data, error } = await scoped(context, 'marketing_forms')
    .insert({
      name,
      // crypto.randomUUID rather than a counter: the suffix exists to stop one
      // account guessing or squatting another's address, so it has to be random.
      slug: suggestSlug(name, crypto.randomUUID().replace(/-/g, '')),
      headline: name,
      fields: startingQuestions(),
      created_by: context.user.id,
    })
    .select('id')
    .maybeSingle()

  if (error) return { error: error.message }

  revalidatePath('/forms')
  redirect(`/forms/${(data as { id: string }).id}`)
}

const settingsSchema = z.object({
  name: z.string().trim().min(1, 'A form needs a name').max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/,
      'The address may use lower-case letters, numbers and hyphens, and needs at least three characters',
    ),
  headline: z.string().trim().min(1, 'The form needs a heading').max(200),
  blurb: z.string().trim().max(2000).default(''),
  submit_label: z.string().trim().min(1, 'The button needs a label').max(60),
  success_message: z.string().trim().min(1, 'Say something after they submit').max(2000),
  redirect_url: z.string().trim().max(2000).default(''),
  closed_message: z.string().trim().min(1).max(2000),
  consent_basis: z.enum(['express', 'implied', 'none']),
  consent_label: z.string().trim().max(500).default(''),
  consent_required: z.coerce.boolean().default(false),
  source: z.string().trim().max(160).default(''),
  lifecycle_stage: z.enum(['lead', 'qualified', 'other']),
  list_id: z.string().uuid().or(z.literal('')).default(''),
  owner_id: z.string().uuid().or(z.literal('')).default(''),
  notify_user_id: z.string().uuid().or(z.literal('')).default(''),
})

export async function updateForm(_state: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireSession()
  if (!context.canWrite) return { error: 'Your role does not allow editing forms.' }

  const id = String(formData.get('id') ?? '')
  const raw = Object.fromEntries(formData)
  const parsed = settingsSchema.safeParse({
    ...raw,
    // An unticked checkbox posts nothing at all, which coerce would read as the
    // string "undefined" rather than as false.
    consent_required: formData.get('consent_required') === 'on',
  })

  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the details' }
  const input = parsed.data

  if (input.redirect_url && !/^https?:\/\//i.test(input.redirect_url)) {
    return { error: 'The thank-you page has to be a full https:// address.' }
  }

  if (input.consent_basis === 'express' && !input.consent_label) {
    return { error: 'An express-consent form needs the words of its tick box.' }
  }

  const { error } = await scoped(context, 'marketing_forms')
    .update({
      name: input.name,
      slug: input.slug,
      headline: input.headline,
      blurb: input.blurb || null,
      submit_label: input.submit_label,
      success_message: input.success_message,
      redirect_url: input.redirect_url || null,
      closed_message: input.closed_message,
      consent_basis: input.consent_basis,
      consent_label: input.consent_label,
      consent_required: input.consent_basis === 'express' && input.consent_required,
      source: input.source || null,
      lifecycle_stage: input.lifecycle_stage,
      list_id: input.list_id || null,
      owner_id: input.owner_id || null,
      notify_user_id: input.notify_user_id || null,
    })
    .eq('id', id)

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { error: `/f/${input.slug} is taken. Addresses are unique across the whole system, so try another.` }
    }
    return { error: error.message }
  }

  revalidatePath(`/forms/${id}`)
  revalidatePath('/forms')
  return { ok: 'Saved.' }
}

/**
 * The questions, posted as one JSON blob.
 *
 * The row count is dynamic and the shapes differ by type, so serialising the
 * whole list beats inventing an indexed naming scheme this action would then
 * have to unpick — the same trade LinksEditor makes.
 */
export async function saveQuestions(_state: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireSession()
  if (!context.canWrite) return { error: 'Your role does not allow editing forms.' }

  const id = String(formData.get('id') ?? '')

  let fields: FormField[]
  try {
    fields = parseFields(JSON.parse(String(formData.get('fields') ?? '[]')))
  } catch {
    return { error: 'Those questions could not be read. Reload and try again.' }
  }

  const form = await firstRow<MarketingFormRow>(
    scoped(context, 'marketing_forms').select('status').eq('id', id).maybeSingle(),
  )

  // A draft may be saved half-finished; a live form may not be broken while
  // somebody is looking at it.
  if (form?.status === 'published') {
    const problem = whyNotPublishable(fields)
    if (problem) return { error: `${problem} This form is live, so it has to stay answerable.` }
  }

  const { error } = await scoped(context, 'marketing_forms').update({ fields }).eq('id', id)
  if (error) return { error: error.message }

  revalidatePath(`/forms/${id}`)
  return { ok: `Saved ${fields.length} question${fields.length === 1 ? '' : 's'}.` }
}

export async function publishForm(_state: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireSession()
  if (!context.canWrite) return { error: 'Your role does not allow publishing forms.' }

  const id = String(formData.get('id') ?? '')

  const form = await firstRow<MarketingFormRow>(
    scoped(context, 'marketing_forms').select('*').eq('id', id).maybeSingle(),
  )
  if (!form) return { error: 'That form is gone.' }

  const problem = whyNotPublishable(parseFields(form.fields))
  if (problem) return { error: problem }

  const { error } = await scoped(context, 'marketing_forms')
    .update({ status: 'published' })
    .eq('id', id)

  if (error) return { error: error.message }

  revalidatePath(`/forms/${id}`)
  revalidatePath('/forms')
  return { ok: `Live at /f/${form.slug}.` }
}

/**
 * Stops it, without breaking the link.
 *
 * Closed rather than deleted or reverted to draft, because the address may be
 * printed on something. A closed form still answers, and says it has finished.
 */
export async function closeForm(_state: ActionState, formData: FormData): Promise<ActionState> {
  const context = await requireSession()
  if (!context.canWrite) return { error: 'Your role does not allow editing forms.' }

  const id = String(formData.get('id') ?? '')
  const { error } = await scoped(context, 'marketing_forms').update({ status: 'closed' }).eq('id', id)
  if (error) return { error: error.message }

  revalidatePath(`/forms/${id}`)
  revalidatePath('/forms')
  return { ok: 'Closed. The link still works and says so.' }
}

export async function deleteForm(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  if (!context.canDelete) {
    redirect(`/forms/${id}?error=${encodeURIComponent('Your role does not allow deleting forms.')}`)
  }

  /*
   * The submissions go with it, by cascade, and that is the reason this asks
   * twice in the interface. They are the consent record for everybody who ever
   * filled it in — the contacts keep their consent basis, but the evidence for
   * it lives here.
   */
  const { error } = await scoped(context, 'marketing_forms').delete().eq('id', id)
  if (error) redirect(`/forms/${id}?error=${encodeURIComponent(error.message)}`)

  revalidatePath('/forms')
  redirect('/forms?ok=Form+deleted')
}
