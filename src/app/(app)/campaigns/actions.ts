'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { firstRow, requireSession, scoped } from '@/lib/tenancy'
import { isEmailConfigured } from '@/lib/env'
import { isEditable } from '@/lib/campaigns'
import { resolveListContactIds } from '@/lib/audience'
import { applyMergeFields, renderEmail } from '@/lib/email/render'
import { sendEmail, unsubscribeUrlFor } from '@/lib/email/send'
import type { CampaignRow, ContactRow, EmailListRow, SendingDomainRow } from '@/lib/database.types'

/**
 * Everything a person can do to a campaign before it goes out.
 *
 * The rule running through all of it: **sending is a manager action**, and a
 * campaign stops being editable the moment it stops being a draft. Both are
 * enforced here and again in the database, because this is the one feature in
 * the CRM whose mistakes leave the building and cannot be recalled.
 */

function toCampaign(id: string, params: Record<string, string>): never {
  redirect(`/campaigns/${id}?${new URLSearchParams(params).toString()}`)
}

function toIndex(params: Record<string, string>): never {
  redirect(`/campaigns?${new URLSearchParams(params).toString()}`)
}

async function manager() {
  const context = await requireSession()
  if (!context.canManage) {
    toIndex({ error: 'Only an administrator or manager can send campaigns.' })
  }
  return context
}

async function load(context: Awaited<ReturnType<typeof manager>>, id: string) {
  const campaign = await firstRow<CampaignRow>(
    scoped(context, 'campaigns').select('*').eq('id', id).maybeSingle(),
  )
  if (!campaign) toIndex({ error: 'That campaign no longer exists.' })
  return campaign
}

const draftSchema = z.object({
  name: z.string().trim().min(1, 'A campaign needs a name').max(160),
  subject: z.string().trim().min(1, 'A subject is needed').max(200),
  body: z.string().trim().min(1, 'Write something to send').max(50_000),
  list_id: z.string().uuid('Choose a list').or(z.literal('')).default(''),
})

export async function createCampaign(formData: FormData) {
  const context = await manager()

  const parsed = draftSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    toIndex({ error: parsed.error.issues[0]?.message ?? 'Check the campaign details' })
  }
  const input = parsed.data

  const { data, error } = await scoped(context, 'campaigns')
    .insert({
      name: input.name,
      subject: input.subject,
      body: input.body,
      list_id: input.list_id || null,
      status: 'draft',
      created_by: context.user.id,
    })
    .select('id')
    .maybeSingle()

  if (error) toIndex({ error: error.message })

  revalidatePath('/campaigns')
  redirect(`/campaigns/${(data as { id: string }).id}`)
}

export async function updateCampaign(formData: FormData) {
  const context = await manager()
  const id = String(formData.get('id') ?? '')
  const campaign = await load(context, id)

  if (!isEditable(campaign.status)) {
    toCampaign(id, { error: 'This campaign has been scheduled, so its wording is fixed.' })
  }

  const parsed = draftSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    toCampaign(id, { error: parsed.error.issues[0]?.message ?? 'Check the campaign details' })
  }
  const input = parsed.data

  /*
   * Changing the list invalidates the audience that was built from the old one.
   * Clearing it here rather than merging is the safe direction: the alternative
   * is a campaign that quietly goes to both lists.
   */
  const listChanged = (input.list_id || null) !== campaign.list_id

  const { error } = await scoped(context, 'campaigns')
    .update({
      name: input.name,
      subject: input.subject,
      body: input.body,
      list_id: input.list_id || null,
    })
    .eq('id', id)

  if (error) toCampaign(id, { error: error.message })

  if (listChanged) {
    await context.supabase.rpc('clear_campaign_audience', { p_campaign_id: id })
  }

  revalidatePath(`/campaigns/${id}`)
  toCampaign(id, {
    ok: listChanged ? 'Saved. The audience was cleared because the list changed.' : 'Saved.',
  })
}

/**
 * Works out who this campaign would go to, and writes the outbox.
 *
 * Separate from scheduling on purpose: the number of people about to receive
 * something, and the number being withheld and why, is worth looking at before
 * committing rather than discovering afterwards.
 */
export async function buildAudience(formData: FormData) {
  const context = await manager()
  const id = String(formData.get('id') ?? '')
  const campaign = await load(context, id)

  if (!campaign.list_id) {
    toCampaign(id, { error: 'Choose a list first — there is nobody to send to yet.' })
  }

  const list = await firstRow<EmailListRow>(
    scoped(context, 'email_lists').select('*').eq('id', campaign.list_id).maybeSingle(),
  )
  if (!list) toCampaign(id, { error: 'That list no longer exists.' })

  const contactIds = await resolveListContactIds(context, list)
  if (contactIds.length === 0) {
    toCampaign(id, { error: 'That list resolves to nobody right now.' })
  }

  const { data, error } = await context.supabase.rpc('build_campaign_audience_for', {
    p_campaign_id: id,
    p_contact_ids: contactIds,
  })

  if (error) toCampaign(id, { error: error.message })

  revalidatePath(`/campaigns/${id}`)
  toCampaign(id, { ok: `Audience built — ${data ?? 0} added.` })
}

export async function clearAudience(formData: FormData) {
  const context = await manager()
  const id = String(formData.get('id') ?? '')
  await load(context, id)

  const { data, error } = await context.supabase.rpc('clear_campaign_audience', {
    p_campaign_id: id,
  })
  if (error) toCampaign(id, { error: error.message })

  revalidatePath(`/campaigns/${id}`)
  toCampaign(id, { ok: `Audience cleared — ${data ?? 0} removed.` })
}

const scheduleSchema = z.object({
  /** Empty means now. A datetime-local value carries no zone, so it is read in the browser's. */
  when: z.string().trim().default(''),
})

/**
 * Hands the campaign to the sender.
 *
 * Nothing is sent from here. The status becomes `scheduled` and the cron job
 * takes it from there — which is what makes a send survive this request, this
 * deployment, and anything else that happens in the next hour.
 */
export async function scheduleCampaign(formData: FormData) {
  const context = await manager()
  const id = String(formData.get('id') ?? '')
  const campaign = await load(context, id)

  if (campaign.status !== 'draft') {
    toCampaign(id, { error: 'Only a draft can be scheduled.' })
  }

  if (!isEmailConfigured()) {
    toCampaign(id, { error: 'Email sending is not configured on this deployment.' })
  }

  const sender = await firstRow<SendingDomainRow>(
    scoped(context, 'sending_domains').select('*').maybeSingle(),
  )
  if (!sender) {
    toCampaign(id, {
      error: 'Set up the sender under Settings → Email sending first — there is no From address.',
    })
  }

  // The outbox is the audience. Scheduling without one would produce a campaign
  // that completes instantly having reached nobody.
  const { count } = await scoped(context, 'campaign_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', id)
    .eq('status', 'pending')

  if (!count) {
    toCampaign(id, { error: 'Nobody is queued to receive this. Build the audience first.' })
  }

  const parsed = scheduleSchema.safeParse(Object.fromEntries(formData))
  const when = parsed.success ? parsed.data.when : ''

  let scheduledAt = new Date()
  if (when) {
    const parsedDate = new Date(when)
    if (Number.isNaN(parsedDate.getTime())) {
      toCampaign(id, { error: 'That is not a valid date and time.' })
    }
    scheduledAt = parsedDate
  }

  const { error } = await scoped(context, 'campaigns')
    .update({ status: 'scheduled', scheduled_at: scheduledAt.toISOString() })
    .eq('id', id)

  if (error) toCampaign(id, { error: error.message })

  revalidatePath(`/campaigns/${id}`)
  revalidatePath('/campaigns')
  toCampaign(id, {
    ok: when
      ? `Scheduled. ${count} ${count === 1 ? 'person' : 'people'} will receive it.`
      : `Sending now to ${count} ${count === 1 ? 'person' : 'people'}. It goes out over the next few minutes.`,
  })
}

/**
 * Stops a campaign part-way.
 *
 * Whatever has already been handed to the provider is gone — there is no
 * recalling an email. What this does is stop the rest, which is the only thing
 * anybody can actually do at this point, and it is worth being able to do fast.
 */
export async function pauseCampaign(formData: FormData) {
  const context = await manager()
  const id = String(formData.get('id') ?? '')
  const campaign = await load(context, id)

  if (!['scheduled', 'sending'].includes(campaign.status)) {
    toCampaign(id, { error: 'Only a campaign that is scheduled or sending can be paused.' })
  }

  const { error } = await scoped(context, 'campaigns').update({ status: 'paused' }).eq('id', id)
  if (error) toCampaign(id, { error: error.message })

  revalidatePath(`/campaigns/${id}`)
  toCampaign(id, { ok: 'Paused. Nobody else will be sent to.' })
}

export async function resumeCampaign(formData: FormData) {
  const context = await manager()
  const id = String(formData.get('id') ?? '')
  const campaign = await load(context, id)

  if (campaign.status !== 'paused') {
    toCampaign(id, { error: 'Only a paused campaign can be resumed.' })
  }

  // Back to scheduled rather than straight to sending, so the same cron path
  // starts it. One way in means one thing to reason about.
  const { error } = await scoped(context, 'campaigns')
    .update({ status: 'scheduled', scheduled_at: new Date().toISOString() })
    .eq('id', id)

  if (error) toCampaign(id, { error: error.message })

  revalidatePath(`/campaigns/${id}`)
  toCampaign(id, { ok: 'Resumed. The rest goes out over the next few minutes.' })
}

export async function deleteCampaign(formData: FormData) {
  const context = await manager()
  const id = String(formData.get('id') ?? '')
  const campaign = await load(context, id)

  // A sent campaign is a record of what people were sent. Deleting it would
  // throw away the only account of that, so it stays.
  if (!['draft', 'failed'].includes(campaign.status)) {
    toCampaign(id, { error: 'A campaign that has been sent is kept as a record.' })
  }

  const { error } = await scoped(context, 'campaigns').delete().eq('id', id)
  if (error) toCampaign(id, { error: error.message })

  revalidatePath('/campaigns')
  toIndex({ ok: 'Campaign deleted.' })
}

const testSchema = z.object({ to: z.string().trim().email('That is not an email address') })

/**
 * Sends this exact campaign to one address.
 *
 * The same renderer, the same provider call, the same headers a real send uses
 * — because a preview in a browser proves the template and nothing else. Only a
 * delivered message proves the DNS, the key, the footer and how it looks in the
 * client the recipients actually use.
 *
 * It does not consult consent: the address is typed by hand rather than chosen
 * from the database, so this cannot become a way to reach a blocked contact.
 */
export async function sendCampaignTest(formData: FormData) {
  const context = await manager()
  const id = String(formData.get('id') ?? '')
  const campaign = await load(context, id)

  if (!isEmailConfigured()) {
    toCampaign(id, { error: 'RESEND_API_KEY is not set on this deployment.' })
  }

  const parsed = testSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    toCampaign(id, { error: parsed.error.issues[0]?.message ?? 'Check the address' })
  }
  const to = parsed.data.to

  const sender = await firstRow<SendingDomainRow>(
    scoped(context, 'sending_domains').select('*').maybeSingle(),
  )
  if (!sender) {
    toCampaign(id, { error: 'Set up the sender first — there is no From address to send as.' })
  }

  // A real contact's token where there is one, so the unsubscribe link in the
  // test is a link that genuinely works. Testing the footer is half the point.
  const sample = await firstRow<Pick<ContactRow, 'first_name' | 'last_name' | 'unsubscribe_token'>>(
    scoped(context, 'contacts')
      .select('first_name, last_name, unsubscribe_token')
      .not('unsubscribe_token', 'is', null)
      .limit(1)
      .maybeSingle(),
  )

  const values = {
    first_name: sample?.first_name ?? 'there',
    last_name: sample?.last_name ?? '',
    company: context.organization.name,
    email: to,
  }

  const unsubscribeUrl = unsubscribeUrlFor(
    sample?.unsubscribe_token ?? '00000000-0000-0000-0000-000000000000',
  )

  let rendered
  try {
    rendered = renderEmail({
      subject: applyMergeFields(campaign.subject, values),
      body: applyMergeFields(campaign.body, values),
      organizationName: sender.from_name,
      logoUrl: context.organization.logo_url,
      postalAddress: sender.postal_address,
      unsubscribeUrl,
    })
  } catch (renderError) {
    toCampaign(id, {
      error: renderError instanceof Error ? renderError.message : 'The message could not be built.',
    })
  }

  const result = await sendEmail({
    ...rendered,
    to,
    from: { name: sender.from_name, address: `${sender.from_local}@${sender.domain}` },
    replyTo: sender.reply_to,
    unsubscribeUrl,
  })

  revalidatePath(`/campaigns/${id}`)

  if (!result.ok) toCampaign(id, { error: result.error ?? 'The provider refused the message.' })
  toCampaign(id, { ok: `Test sent to ${to}.` })
}
