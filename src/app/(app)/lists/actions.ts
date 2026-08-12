'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireSession, scoped } from '@/lib/tenancy'

/**
 * Lists — a saved audience.
 *
 * Two kinds, told apart by whether a saved filter is attached: a static list is
 * an explicit set of people, a dynamic one re-reads its filter at send time so
 * it stays current.
 *
 * `source_note` is required on purpose. A list assembled from a trade show
 * badge scan and a list of existing customers have different standing, and the
 * difference has to be recorded while somebody still remembers it. Asking for
 * it at the moment the list is made costs one sentence; reconstructing it a
 * year later costs a great deal more.
 */

const listSchema = z.object({
  name: z.string().trim().min(1, 'A list needs a name').max(160),
  description: z.string().trim().max(2000).default(''),
  source_note: z
    .string()
    .trim()
    .min(1, 'Say where these contacts came from — it is the record of why they may be emailed')
    .max(2000),
  saved_filter_id: z.string().uuid().or(z.literal('')).default(''),
})

function backToLists(params: Record<string, string>): never {
  redirect(`/lists?${new URLSearchParams(params).toString()}`)
}

export async function createList(formData: FormData) {
  const context = await requireSession()
  if (!context.canWrite) backToLists({ error: 'Your role does not allow creating lists.' })

  const parsed = listSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    backToLists({ error: parsed.error.issues[0]?.message ?? 'Check the list details' })
  }
  const input = parsed.data

  const { data, error } = await scoped(context, 'email_lists')
    .insert({
      name: input.name,
      description: input.description || null,
      source_note: input.source_note,
      saved_filter_id: input.saved_filter_id || null,
      created_by: context.user.id,
    })
    .select('id')
    .maybeSingle()

  if (error) backToLists({ error: error.message })

  revalidatePath('/lists')
  redirect(`/lists/${(data as { id: string }).id}`)
}

export async function deleteList(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const { error } = await scoped(context, 'email_lists').delete().eq('id', id)
  if (error) backToLists({ error: error.message })

  revalidatePath('/lists')
  redirect('/lists?ok=List+deleted')
}

/**
 * Puts the contacts somebody selected into a list.
 *
 * Reached from the contacts list, so it takes the same `ids` the bulk bar does.
 * Anything already in the list is skipped rather than duplicated — the unique
 * index does that, and the count returned is what actually went in.
 */
export async function addContactsToList(formData: FormData) {
  const context = await requireSession()

  const listId = String(formData.get('list_id') ?? '')
  const ids = formData.getAll('ids').map(String).filter(Boolean)

  if (!listId) redirect('/contacts?error=Pick+a+list')
  if (ids.length === 0) redirect('/contacts?error=Select+some+contacts+first')

  if (!context.canWrite) {
    redirect('/contacts?error=Your+role+does+not+allow+editing+lists')
  }

  /*
   * The contacts are read back before being written in, so a selection naming
   * somebody else's record adds nothing: the read is filtered by the same row
   * policies an ordinary edit would face.
   */
  const { data: visible } = await scoped(context, 'contacts').select('id').in('id', ids)
  const allowed = ((visible ?? []) as { id: string }[]).map((row) => row.id)

  if (allowed.length === 0) {
    redirect(`/lists/${listId}?error=None+of+those+contacts+are+yours+to+add`)
  }

  /*
   * Anyone already on the list is filtered out first rather than relying on the
   * insert to collide: it keeps the added_at of the original membership, and it
   * makes the count reported below the number of people genuinely added.
   */
  const { data: existing } = await scoped(context, 'email_list_members')
    .select('contact_id')
    .eq('list_id', listId)
    .in('contact_id', allowed)

  const already = new Set(((existing ?? []) as { contact_id: string }[]).map((r) => r.contact_id))
  const fresh = allowed.filter((contactId) => !already.has(contactId))

  if (fresh.length > 0) {
    const { error } = await scoped(context, 'email_list_members').insert(
      fresh.map((contactId) => ({
        list_id: listId,
        contact_id: contactId,
        added_by: context.user.id,
      })),
    )

    if (error) redirect(`/lists/${listId}?error=${encodeURIComponent(error.message)}`)
  }

  revalidatePath(`/lists/${listId}`)
  const skipped = ids.length - fresh.length
  redirect(
    `/lists/${listId}?ok=${encodeURIComponent(
      skipped > 0
        ? `${fresh.length} added, ${skipped} skipped — already on the list, or not yours to add.`
        : `${fresh.length} added.`,
    )}`,
  )
}

export async function removeFromList(formData: FormData) {
  const context = await requireSession()
  const listId = String(formData.get('list_id') ?? '')
  const contactId = String(formData.get('contact_id') ?? '')

  await scoped(context, 'email_list_members')
    .delete()
    .eq('list_id', listId)
    .eq('contact_id', contactId)

  revalidatePath(`/lists/${listId}`)
  redirect(`/lists/${listId}`)
}

/**
 * Records consent across a selection.
 *
 * The first real job this feature has: several hundred existing contacts with
 * no provenance at all, and a person who knows which of them are customers.
 * The database function refuses to touch anybody who has unsubscribed.
 */
const consentSchema = z.object({
  consent: z.enum(['express', 'implied', 'none']),
  source: z.string().trim().max(2000).default(''),
})

export async function recordConsent(formData: FormData) {
  const context = await requireSession()

  const ids = formData.getAll('ids').map(String).filter(Boolean)
  if (ids.length === 0) redirect('/contacts?error=Select+some+contacts+first')

  if (!context.canWrite) {
    redirect('/contacts?error=Your+role+does+not+allow+editing+contacts')
  }

  const parsed = consentSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    redirect('/contacts?error=Choose+a+consent+basis')
  }

  const { consent, source } = parsed.data

  if (consent !== 'none' && !source) {
    redirect('/contacts?error=Say+where+the+consent+came+from')
  }

  const { data, error } = await context.supabase.rpc('bulk_set_consent', {
    p_ids: ids,
    p_consent: consent,
    p_source: source,
  })

  if (error) redirect(`/contacts?error=${encodeURIComponent(error.message)}`)

  const changed = Number(data ?? 0)
  const skipped = ids.length - changed
  revalidatePath('/contacts')
  redirect(
    `/contacts?ok=${encodeURIComponent(
      skipped > 0
        ? `Consent recorded on ${changed}. ${skipped} skipped — unsubscribed, or not yours to edit.`
        : `Consent recorded on ${changed}.`,
    )}`,
  )
}
