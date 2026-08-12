'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requireAdmin, requireSession, scoped } from '@/lib/tenancy'
import { isEmailConfigured } from '@/lib/env'
import { applyMergeFields, renderEmail } from '@/lib/email/render'
import { sendEmail, unsubscribeUrlFor } from '@/lib/email/send'
import type { ContactRow, SendingDomainRow } from '@/lib/database.types'

function back(params: Record<string, string>): never {
  redirect(`/settings/email?${new URLSearchParams(params).toString()}`)
}

const senderSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1, 'The sending domain is needed')
    .max(255)
    // A bare hostname, not a URL and not an address. Anything else produces a
    // From line the provider will reject, which is a worse error to debug.
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'That does not look like a domain — try news.example.com'),
  from_name: z.string().trim().min(1, 'A name to send as is needed').max(120),
  from_local: z
    .string()
    .trim()
    .min(1, 'The part before the @ is needed')
    .max(64)
    .regex(/^[a-z0-9._-]+$/i, 'Letters, numbers, dots, dashes and underscores only'),
  reply_to: z.string().trim().email('That is not an email address').or(z.literal('')).default(''),
  postal_address: z.string().trim().max(500).default(''),
})

/**
 * Who this organization sends as.
 *
 * Administrator only, because it is the name on every message that leaves the
 * building — and because each account having its own is what keeps one
 * account's sending reputation from becoming another's problem.
 */
export async function saveSender(formData: FormData) {
  const context = await requireAdmin()

  const parsed = senderSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    back({ error: parsed.error.issues[0]?.message ?? 'Check the sender details' })
  }
  const input = parsed.data

  const existing = await scoped(context, 'sending_domains').select('id').maybeSingle()
  const row = {
    domain: input.domain.toLowerCase(),
    from_name: input.from_name,
    from_local: input.from_local.toLowerCase(),
    reply_to: input.reply_to || null,
    postal_address: input.postal_address || null,
    updated_at: new Date().toISOString(),
  }

  const { error } = existing.data
    ? await scoped(context, 'sending_domains')
        .update(row)
        .eq('id', (existing.data as { id: string }).id)
    : await scoped(context, 'sending_domains').insert({ ...row, created_by: context.user.id })

  if (error) back({ error: error.message })

  revalidatePath('/settings/email')
  back({ ok: 'Sender saved.' })
}

const testSchema = z.object({
  to: z.string().trim().email('That is not an email address'),
  subject: z.string().trim().min(1, 'A subject is needed').max(200),
  body: z.string().trim().min(1, 'Write something to send').max(20_000),
})

/**
 * One real email, to prove the whole path works.
 *
 * Deliberately not a "preview": it goes through the same renderer and the same
 * provider call a campaign will, carries a real unsubscribe link, and lands in
 * a real inbox. A preview that renders in a browser proves the template; only
 * a delivered message proves the DNS, the key, the headers and the domain.
 *
 * It is addressed by hand rather than to a contact, and it does not consult
 * consent — nobody needs permission to be sent a test they asked for. Which is
 * also why this cannot become a way to mail a contact who is blocked: the
 * address is typed, not chosen from the database.
 */
export async function sendTest(formData: FormData) {
  const context = await requireAdmin()

  if (!isEmailConfigured()) {
    back({ error: 'RESEND_API_KEY is not set on this deployment, so nothing can be sent yet.' })
  }

  const parsed = testSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    back({ error: parsed.error.issues[0]?.message ?? 'Check the test message' })
  }
  const input = parsed.data

  const { data: senderRow } = await scoped(context, 'sending_domains').select('*').maybeSingle()
  const sender = senderRow as SendingDomainRow | null

  if (!sender) {
    back({ error: 'Set up the sender first — there is no From address to send as.' })
  }

  /*
   * A real contact's token when there is one, so the unsubscribe link in the
   * test is a link that genuinely works rather than a plausible-looking dead
   * one. Testing the footer is half the point of sending a test at all.
   */
  const { data: anyContact } = await scoped(context, 'contacts')
    .select('first_name, last_name, email, unsubscribe_token')
    .not('unsubscribe_token', 'is', null)
    .limit(1)
    .maybeSingle()

  const sample = anyContact as Pick<
    ContactRow,
    'first_name' | 'last_name' | 'email' | 'unsubscribe_token'
  > | null

  const merged = applyMergeFields(input.body, {
    first_name: sample?.first_name ?? 'there',
    last_name: sample?.last_name ?? '',
    company: context.organization.name,
    email: input.to,
  })

  const rendered = renderEmail({
    subject: input.subject,
    body: merged,
    organizationName: context.organization.name,
    logoUrl: context.organization.logo_url,
    postalAddress: sender.postal_address,
    unsubscribeUrl: unsubscribeUrlFor(
      sample?.unsubscribe_token ?? '00000000-0000-0000-0000-000000000000',
    ),
  })

  const result = await sendEmail({
    ...rendered,
    to: input.to,
    from: { name: sender.from_name, address: `${sender.from_local}@${sender.domain}` },
    replyTo: sender.reply_to,
    unsubscribeUrl: unsubscribeUrlFor(
      sample?.unsubscribe_token ?? '00000000-0000-0000-0000-000000000000',
    ),
  })

  revalidatePath('/settings/email')

  if (!result.ok) back({ error: result.error ?? 'Resend refused the message.' })
  back({ ok: `Sent to ${input.to}. Resend id ${result.id ?? 'unknown'}.` })
}

/** Lets a non-admin page reuse the sender without importing the admin guard. */
export async function currentSender(): Promise<SendingDomainRow | null> {
  const context = await requireSession()
  const { data } = await scoped(context, 'sending_domains').select('*').maybeSingle()
  return (data as SendingDomainRow | null) ?? null
}
