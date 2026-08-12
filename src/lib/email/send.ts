import { resendApiKey, siteUrl } from '@/lib/env'

import type { RenderedEmail } from './render'

/**
 * Handing a finished message to Resend.
 *
 * Thin on purpose. The interesting decisions — who may be emailed, what the
 * message says, whether it carries an unsubscribe link — are all made before
 * anything reaches here. This function's whole job is the HTTP call and the
 * headers that make an inbox trust it.
 */

export interface SendableEmail extends RenderedEmail {
  to: string
  from: { name: string; address: string }
  replyTo?: string | null
  /** The recipient's own unsubscribe link, for the headers. */
  unsubscribeUrl: string
}

export interface SendResult {
  ok: boolean
  /** Resend's id for the message, which later webhooks refer to. */
  id?: string
  error?: string
}

const ENDPOINT = 'https://api.resend.com/emails'

/**
 * The unsubscribe link for one contact, as an absolute URL.
 *
 * Absolute because it goes in an email: a relative path has nothing to resolve
 * against once it is sitting in somebody's inbox.
 */
export function unsubscribeUrlFor(token: string): string {
  return `${siteUrl().replace(/\/$/, '')}/unsubscribe?t=${encodeURIComponent(token)}`
}

export async function sendEmail(email: SendableEmail): Promise<SendResult> {
  const key = resendApiKey()
  if (!key) {
    return { ok: false, error: 'RESEND_API_KEY is not set, so nothing can be sent.' }
  }

  /*
   * List-Unsubscribe and its -Post companion are what Gmail and Yahoo have
   * required from bulk senders since 2024. Together they put a real
   * "Unsubscribe" control in the inbox chrome, above the message — which is
   * the one people press instead of "report spam". A complaint costs the
   * sending domain far more than an unsubscribe does, so these headers are
   * closer to reputation insurance than to compliance paperwork.
   */
  const headers: Record<string, string> = {
    'List-Unsubscribe': `<${email.unsubscribeUrl}>, <${siteUrl().replace(/\/$/, '')}/api/unsubscribe>`,
    'List-Unsubscribe-Post': 'List=Unsubscribe=One-Click',
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${email.from.name} <${email.from.address}>`,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        headers,
      }),
    })

    const payload = (await response.json().catch(() => null)) as
      | { id?: string; message?: string; name?: string }
      | null

    if (!response.ok) {
      // Resend's message is written for a developer and is worth surfacing
      // verbatim — "domain is not verified" is a great deal more useful than
      // "sending failed".
      return {
        ok: false,
        error: payload?.message ?? `Resend refused the message (${response.status})`,
      }
    }

    return { ok: true, id: payload?.id }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not reach Resend',
    }
  }
}
