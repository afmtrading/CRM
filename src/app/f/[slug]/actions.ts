'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { isSupabaseConfigured } from '@/lib/env'
import { createSupabaseAnonClient } from '@/lib/supabase/server'
import type { ActionState } from '@/components/action-form'

/**
 * Accepting a submission from somebody with no account.
 *
 * Almost nothing happens here. The whole capture — validation, dedupe, consent,
 * routing, the list, the notification — is one database function, because those
 * steps have to succeed or fail together: a contact with no submission behind it
 * and a consent record with no contact are both worse than nothing, since each
 * is supposed to be the evidence for the other. This layer collects the request,
 * strips the parts that are ours rather than the visitor's, and calls it.
 *
 * It runs as `anon`, deliberately holding no cookies. A colleague who happens to
 * be signed in must submit a form exactly the way a stranger does.
 */

/** Answers arrive namespaced, so nothing else on the form can be mistaken for one. */
const ANSWER_PREFIX = 'q.'

export async function submitForm(_state: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSupabaseConfigured()) {
    return { error: 'This form is not available right now.' }
  }

  const slug = String(formData.get('slug') ?? '').trim()
  if (!slug) return { error: 'This form is not available right now.' }

  /*
   * The honeypot: a field a person never sees and a form-filling bot cannot
   * resist. Answered means a robot, and the answer is a plain thank-you rather
   * than a refusal, because a bot told it failed comes back and tries again.
   *
   * There is deliberately no timing trap alongside it. "Submitted too fast" is
   * the check that fires on somebody using autofill on a two-field form, and
   * silently discarding a real lead costs more than the spam it stops.
   */
  if (String(formData.get('website') ?? '').trim() !== '') {
    return { ok: 'Thanks — we have got that.' }
  }

  const answers: Record<string, string> = {}
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith(ANSWER_PREFIX) || typeof value !== 'string') continue
    answers[name.slice(ANSWER_PREFIX.length)] = value
  }

  let utm: Record<string, string> = {}
  try {
    const parsed: unknown = JSON.parse(String(formData.get('utm') ?? '{}'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      utm = parsed as Record<string, string>
    }
  } catch {
    // A mangled hidden field is not worth losing the submission over.
  }

  const supabase = createSupabaseAnonClient()

  const { data, error } = await supabase.rpc('submit_marketing_form', {
    p_slug: slug,
    p_answers: answers,
    p_consent: formData.get('consent') === 'on',
    p_meta: {
      page_url: String(formData.get('page_url') ?? '') || null,
      referrer: String(formData.get('referrer') ?? '') || null,
      utm,
      user_agent: (await headers()).get('user-agent'),
    },
  })

  if (error) {
    return { error: 'That did not go through. Try again in a moment.' }
  }

  const result = (data ?? {}) as { ok?: boolean; error?: string; message?: string; redirect_url?: string | null }

  if (result.ok !== true) {
    return { error: result.error ?? 'That did not go through. Try again in a moment.' }
  }

  /*
   * Outside every try/catch: redirect() works by throwing, and a catch would
   * swallow it and leave the person looking at a form they have already sent.
   */
  if (result.redirect_url) redirect(result.redirect_url)

  return { ok: result.message ?? 'Thanks — we have got that.' }
}
