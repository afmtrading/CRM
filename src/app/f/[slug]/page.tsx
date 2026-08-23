import { headers } from 'next/headers'
import { notFound } from 'next/navigation'

import { isSupabaseConfigured } from '@/lib/env'
import { createSupabaseAnonClient } from '@/lib/supabase/server'
import { parseFields, readUtm, type FormField } from '@/lib/forms'

import { PublicForm } from './public-form'

/**
 * A marketing form, as the public meets it.
 *
 * Nobody here is signed in and nobody should have to be, so this builds an
 * anonymous client rather than going through the tenancy helper — the same
 * shape the unsubscribe page uses, and for the same reason. `anon` may execute
 * two functions on these tables and read neither of them: one returns a
 * published form's public half, the other accepts a submission.
 *
 * Two ways in, one page. Opened directly it is a standalone page; opened inside
 * an iframe with ?embed=1 it drops the outer chrome so it sits inside somebody
 * else's design instead of arguing with it.
 */

type PublicFormShape = {
  slug: string
  status: 'published' | 'closed'
  headline: string
  blurb: string | null
  submit_label: string
  closed_message: string
  fields: unknown
  consent_basis: string
  consent_label: string
  consent_required: boolean
  organization_name: string
  brand_color: string
}

async function loadForm(slug: string): Promise<PublicFormShape | null> {
  if (!isSupabaseConfigured()) return null

  const supabase = createSupabaseAnonClient()
  const { data } = await supabase.rpc('marketing_form_public', { p_slug: slug })

  return (data as PublicFormShape | null) ?? null
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const form = await loadForm((await params).slug)

  return {
    title: form ? `${form.headline} · ${form.organization_name}` : 'Form',
    /*
     * Not indexed. The page that should rank is the customer's own page with
     * this embedded in it; a second copy of the same form on our domain
     * competes with it and answers no question a search brought somebody to.
     */
    robots: { index: false, follow: false },
  }
}

export default async function PublicFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { slug } = await params
  const query = await searchParams
  const form = await loadForm(slug)

  // A draft returns nothing at all: an unpublished form should not be findable
  // by guessing its address.
  if (!form) notFound()

  const embedded = query.embed === '1'

  /*
   * The referrer of *this* request, captured while it is still knowable.
   *
   * Inside an embedded iframe it is the customer's own page — the one fact
   * about where the visitor was that is otherwise unreachable from here, since
   * a frame cannot read its parent's URL across origins. Opened directly it is
   * whatever linked here, which is nearly as useful.
   */
  const referrer = (await headers()).get('referer') ?? ''

  const body =
    form.status === 'closed' ? (
      <p className="text-sm text-slate-600">{form.closed_message}</p>
    ) : (
      <PublicForm
        slug={form.slug}
        fields={parseFields(form.fields as never) as FormField[]}
        submitLabel={form.submit_label}
        consentBasis={form.consent_basis}
        consentLabel={form.consent_label}
        consentRequired={form.consent_required}
        brandColor={form.brand_color}
        meta={{ page_url: referrer, referrer, utm: readUtm(query) }}
      />
    )

  const panel = (
    <div className={embedded ? 'w-full max-w-xl' : 'card w-full max-w-xl p-6 sm:p-8'}>
      <header className="mb-5">
        <p className="text-xs font-semibold tracking-widest text-slate-400 uppercase">
          {form.organization_name}
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">{form.headline}</h1>
        {form.blurb && <p className="mt-2 text-sm text-slate-600">{form.blurb}</p>}
      </header>

      {body}
    </div>
  )

  if (embedded) {
    // Transparent, unpadded and not centred vertically: the host page decides
    // where this sits and what colour is behind it.
    return <main className="p-1">{panel}</main>
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      {panel}
    </main>
  )
}
