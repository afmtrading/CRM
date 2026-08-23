import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { siteUrl } from '@/lib/env'
import type { MarketingFormRow } from '@/lib/database.types'
import { FORM_STATUS_LABELS, FORM_STATUS_STYLES, formUrl, parseFields } from '@/lib/forms'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { DateTime } from '@/components/date-time'
import { EmptyState, ErrorNote, PageHeader, Section } from '@/components/ui'

import { createForm } from './actions'

export const metadata = { title: 'Forms · FLO CRM' }

export default async function FormsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>
}) {
  const { error, ok } = await searchParams
  const context = await requireSession()

  const { data } = await scoped(context, 'marketing_forms')
    .select('*')
    .order('created_at', { ascending: false })

  const forms = (data ?? []) as MarketingFormRow[]
  const site = siteUrl()

  return (
    <>
      <PageHeader
        title="Forms"
        description="The way somebody who is not in the CRM gets into it — and, for an express-consent form, the only place the consent to email them is actually created."
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {ok && (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          {ok}
        </p>
      )}

      {context.canWrite && (
        <Section title="New form">
          <ActionForm action={createForm} className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <label className="label" htmlFor="name">
                What is it for?
              </label>
              <input
                id="name"
                name="name"
                required
                maxLength={160}
                className="input"
                placeholder="Request a pallet quote"
              />
              <p className="mt-1 text-xs text-slate-500">
                Starts with a name, an email, a company and a message — edit them next.
              </p>
            </div>
            <SubmitButton className="btn-primary" pendingLabel="Creating…">
              Create form
            </SubmitButton>
          </ActionForm>
        </Section>
      )}

      <div className="mt-5">
        {forms.length === 0 ? (
          <EmptyState
            title="No forms yet"
            description="Make one above, put it on a website, and the leads arrive scored, owned and with their consent on record."
          />
        ) : (
          <div className="card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>Form</th>
                  <th>Status</th>
                  <th>Address</th>
                  <th>Questions</th>
                  <th className="text-right">Submissions</th>
                  <th>Last one</th>
                </tr>
              </thead>
              <tbody>
                {forms.map((form) => (
                  <tr key={form.id} className="hover:bg-slate-50">
                    <td>
                      <Link
                        href={`/forms/${form.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {form.name}
                      </Link>
                      {form.source && (
                        <span className="ml-2 text-xs text-slate-400">source: {form.source}</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${FORM_STATUS_STYLES[form.status]}`}>
                        {FORM_STATUS_LABELS[form.status]}
                      </span>
                    </td>
                    <td className="text-slate-500">
                      {form.status === 'draft' ? (
                        <span className="text-slate-400">Not live yet</span>
                      ) : (
                        <a
                          href={formUrl(site, form.slug)}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          /f/{form.slug}
                        </a>
                      )}
                    </td>
                    <td className="text-slate-600">{parseFields(form.fields).length}</td>
                    <td className="text-right font-medium text-slate-800">
                      {form.submission_count}
                    </td>
                    <td className="text-slate-500">
                      {form.last_submission_at ? (
                        <DateTime value={form.last_submission_at} />
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
