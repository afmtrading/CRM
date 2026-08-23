import Link from 'next/link'
import { notFound } from 'next/navigation'

import { firstRow, requireSession, scoped } from '@/lib/tenancy'
import { siteUrl } from '@/lib/env'
import type {
  CustomFieldDefinitionRow,
  EmailListRow,
  MarketingFormRow,
  MarketingFormSubmissionRow,
  UserRow,
} from '@/lib/database.types'
import {
  CONSENT_BASIS_OPTIONS,
  FORM_STATUS_LABELS,
  FORM_STATUS_STYLES,
  LIFECYCLE_ON_CAPTURE,
  MAPPING_TARGETS,
  embedSnippet,
  formUrl,
  parseAnswers,
  parseFields,
} from '@/lib/forms'
import { LIFECYCLE_LABELS } from '@/lib/field-options'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { DateTime } from '@/components/date-time'
import { ErrorNote, PageHeader, Section, StatCard, StatGrid } from '@/components/ui'

import { closeForm, deleteForm, publishForm, saveQuestions, updateForm } from '../actions'
import { QuestionEditor } from './question-editor'
import { SharePanel } from './share-panel'

export const metadata = { title: 'Form · FLO CRM' }

export default async function FormPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string; ok?: string }>
}) {
  const { id } = await params
  const { error } = await searchParams
  const context = await requireSession()

  const form = await firstRow<MarketingFormRow>(
    scoped(context, 'marketing_forms').select('*').eq('id', id).maybeSingle(),
  )
  if (!form) notFound()

  const [{ data: users }, { data: lists }, { data: customFields }, { data: submissions }] =
    await Promise.all([
      scoped(context, 'users').select('*').eq('status', 'active').order('name'),
      scoped(context, 'email_lists').select('*').order('name'),
      scoped(context, 'custom_field_definitions').select('*').eq('entity_type', 'contact'),
      scoped(context, 'marketing_form_submissions')
        .select('*')
        .eq('form_id', id)
        .order('created_at', { ascending: false })
        .limit(50),
    ])

  const userList = (users ?? []) as UserRow[]
  const listRows = (lists ?? []) as EmailListRow[]
  const rows = (submissions ?? []) as MarketingFormSubmissionRow[]
  const fields = parseFields(form.fields)
  const site = siteUrl()
  const url = formUrl(site, form.slug)

  /*
   * A question may also fill one of this organization's own contact fields.
   * Worth the extra query: those keys are what the lead-scoring rules address
   * as "custom_fields.key", so a form that fills one is a form that scores.
   */
  const targets = [
    ...MAPPING_TARGETS,
    ...((customFields ?? []) as CustomFieldDefinitionRow[]).map((definition) => ({
      value: `custom_fields.${definition.key}`,
      label: `${definition.label} (custom)`,
    })),
  ]

  const conflicts = rows.filter((row) => row.consent_conflict).length
  const opted = rows.filter((row) => row.consent_given).length

  return (
    <>
      <PageHeader
        title={form.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className={`badge ${FORM_STATUS_STYLES[form.status]}`}>
              {FORM_STATUS_LABELS[form.status]}
            </span>
            {form.status === 'draft' ? (
              <span>Not reachable yet — publish it to give it an address.</span>
            ) : (
              <a href={url} target="_blank" rel="noreferrer" className="hover:underline">
                /f/{form.slug}
              </a>
            )}
          </span>
        }
        actions={
          context.canWrite && (
            <>
              {form.status !== 'published' && (
                <ActionForm action={publishForm}>
                  <input type="hidden" name="id" value={form.id} />
                  <SubmitButton className="btn-primary" pendingLabel="Publishing…">
                    {form.status === 'closed' ? 'Reopen' : 'Publish'}
                  </SubmitButton>
                </ActionForm>
              )}
              {form.status === 'published' && (
                <ActionForm action={closeForm}>
                  <input type="hidden" name="id" value={form.id} />
                  <SubmitButton className="btn-secondary" pendingLabel="Closing…">
                    Close
                  </SubmitButton>
                </ActionForm>
              )}
            </>
          )
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      <StatGrid>
        <StatCard label="Submissions" value={form.submission_count} />
        <StatCard
          label="Opted in"
          value={opted}
          hint={
            form.consent_basis === 'express'
              ? 'Ticked the consent box'
              : 'This form shows no tick box'
          }
        />
        <StatCard
          label="Need a look"
          value={conflicts}
          tone={conflicts > 0 ? 'amber' : 'brand'}
          hint="Opted in, but the address has unsubscribed or bounced before"
        />
        <StatCard
          label="Last one"
          value={
            form.last_submission_at ? <DateTime value={form.last_submission_at} /> : '—'
          }
        />
      </StatGrid>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Section title="Questions">
            <ActionForm action={saveQuestions}>
              <input type="hidden" name="id" value={form.id} />
              <QuestionEditor defaultValue={fields} targets={targets} />
              <div className="mt-4">
                <SubmitButton className="btn-primary" pendingLabel="Saving…">
                  Save questions
                </SubmitButton>
              </div>
            </ActionForm>
          </Section>

          <Section title="Submissions">
            {rows.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nothing yet. Every submission here becomes a contact, and stays here as the
                record of what was actually typed.
              </p>
            ) : (
              <div className="space-y-3">
                {rows.map((row) => (
                  <article
                    key={row.id}
                    className={`rounded-xl border p-3.5 ${
                      row.consent_conflict ? 'border-amber-200 bg-amber-50/50' : 'border-slate-200'
                    }`}
                  >
                    <header className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium text-slate-800">
                        {row.contact_id ? (
                          <Link
                            href={`/contacts/${row.contact_id}`}
                            className="text-brand-700 hover:underline"
                          >
                            {row.name || row.email}
                          </Link>
                        ) : (
                          (row.name ?? row.email ?? 'Someone')
                        )}
                        {row.email && row.name && (
                          <span className="ml-2 text-xs font-normal text-slate-500">
                            {row.email}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500">
                        <DateTime value={row.created_at} />
                      </p>
                    </header>

                    <dl className="mt-2 space-y-1">
                      {parseAnswers(row.answers).map((answer) => (
                        <div key={answer.key} className="flex flex-wrap gap-2 text-sm">
                          <dt className="text-slate-500">{answer.label}:</dt>
                          <dd className="min-w-0 text-slate-800">{answer.value}</dd>
                        </div>
                      ))}
                    </dl>

                    <footer className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      {row.consent_given && (
                        <span
                          className="badge bg-emerald-100 text-emerald-700"
                          title={row.consent_label ?? undefined}
                        >
                          Opted in
                        </span>
                      )}
                      {row.consent_conflict && (
                        <span className="badge bg-amber-100 text-amber-800">
                          Opted in after unsubscribing — nothing was changed
                        </span>
                      )}
                      {Object.entries(
                        (row.utm ?? {}) as Record<string, string>,
                      ).map(([key, value]) => (
                        <span key={key} className="badge bg-slate-100 text-slate-600">
                          {key.replace('utm_', '')}: {value}
                        </span>
                      ))}
                      {row.page_url && (
                        <span className="max-w-full truncate text-slate-400" title={row.page_url}>
                          from {row.page_url}
                        </span>
                      )}
                    </footer>
                  </article>
                ))}
              </div>
            )}
          </Section>
        </div>

        <div className="space-y-5">
          {form.status !== 'draft' && (
            <Section title="Share it">
              <SharePanel url={url} snippet={embedSnippet(url)} />
            </Section>
          )}

          <Section title="Settings">
            <ActionForm action={updateForm} className="space-y-4">
              <input type="hidden" name="id" value={form.id} />

              <div>
                <label className="label" htmlFor="name">
                  Name (internal)
                </label>
                <input id="name" name="name" className="input" defaultValue={form.name} required />
              </div>

              <div>
                <label className="label" htmlFor="slug">
                  Address
                </label>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-slate-400">/f/</span>
                  <input id="slug" name="slug" className="input" defaultValue={form.slug} required />
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Unique across the whole system — the address carries no account name, so two
                  companies cannot both be /f/contact-us.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="headline">
                  Heading
                </label>
                <input
                  id="headline"
                  name="headline"
                  className="input"
                  defaultValue={form.headline}
                  required
                />
              </div>

              <div>
                <label className="label" htmlFor="blurb">
                  Sentence underneath
                </label>
                <textarea
                  id="blurb"
                  name="blurb"
                  rows={2}
                  className="input"
                  defaultValue={form.blurb ?? ''}
                />
              </div>

              <div>
                <label className="label" htmlFor="submit_label">
                  Button
                </label>
                <input
                  id="submit_label"
                  name="submit_label"
                  className="input"
                  defaultValue={form.submit_label}
                  required
                />
              </div>

              <div>
                <label className="label" htmlFor="success_message">
                  After they submit
                </label>
                <textarea
                  id="success_message"
                  name="success_message"
                  rows={2}
                  className="input"
                  defaultValue={form.success_message}
                  required
                />
              </div>

              <div>
                <label className="label" htmlFor="redirect_url">
                  …or send them to a page
                </label>
                <input
                  id="redirect_url"
                  name="redirect_url"
                  className="input"
                  placeholder="https://example.com/thank-you"
                  defaultValue={form.redirect_url ?? ''}
                />
              </div>

              <div>
                <label className="label" htmlFor="closed_message">
                  Once it is closed
                </label>
                <input
                  id="closed_message"
                  name="closed_message"
                  className="input"
                  defaultValue={form.closed_message}
                  required
                />
              </div>

              <fieldset className="border-t border-slate-100 pt-4">
                <legend className="label">Consent</legend>
                <div className="space-y-2">
                  {CONSENT_BASIS_OPTIONS.map((option) => (
                    <label key={option.value} className="flex gap-2 text-sm">
                      <input
                        type="radio"
                        name="consent_basis"
                        value={option.value}
                        defaultChecked={form.consent_basis === option.value}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-medium text-slate-800">{option.label}</span>
                        <span className="block text-xs text-slate-500">{option.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>

                <div className="mt-3">
                  <label className="label" htmlFor="consent_label">
                    The words on the tick box
                  </label>
                  <textarea
                    id="consent_label"
                    name="consent_label"
                    rows={2}
                    className="input"
                    defaultValue={form.consent_label}
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Copied onto every submission as it stood that day. Change it later and the old
                    submissions still read as the person who ticked them saw it.
                  </p>
                </div>

                <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="consent_required"
                    defaultChecked={form.consent_required}
                  />
                  They cannot submit without ticking it
                </label>
                <p className="mt-1 text-xs text-slate-500">
                  Off for a quote request — agreeing to a newsletter and asking for a price are two
                  different acts, and forcing them together is what makes the consent
                  indefensible. On for a form whose whole purpose is the opt-in.
                </p>
              </fieldset>

              <fieldset className="border-t border-slate-100 pt-4">
                <legend className="label">What happens to the lead</legend>

                <div className="space-y-3">
                  <div>
                    <label className="label" htmlFor="source">
                      Source
                    </label>
                    <input
                      id="source"
                      name="source"
                      className="input"
                      placeholder="website"
                      defaultValue={form.source ?? ''}
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Written to the contact, scored by the lead-scoring rules, and matched by any
                      by-source assignment rule.
                    </p>
                  </div>

                  <div>
                    <label className="label" htmlFor="lifecycle_stage">
                      Arrives as
                    </label>
                    <select
                      id="lifecycle_stage"
                      name="lifecycle_stage"
                      className="input"
                      defaultValue={form.lifecycle_stage}
                    >
                      {LIFECYCLE_ON_CAPTURE.map((stage) => (
                        <option key={stage} value={stage}>
                          {LIFECYCLE_LABELS[stage]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="label" htmlFor="owner_id">
                      Owner
                    </label>
                    <select
                      id="owner_id"
                      name="owner_id"
                      className="input"
                      defaultValue={form.owner_id ?? ''}
                    >
                      <option value="">Whoever the assignment rules pick</option>
                      {userList.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name || user.email}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="label" htmlFor="list_id">
                      Add to list
                    </label>
                    <select
                      id="list_id"
                      name="list_id"
                      className="input"
                      defaultValue={form.list_id ?? ''}
                    >
                      <option value="">No list</option>
                      {listRows.map((list) => (
                        <option key={list.id} value={list.id}>
                          {list.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="label" htmlFor="notify_user_id">
                      Tell
                    </label>
                    <select
                      id="notify_user_id"
                      name="notify_user_id"
                      className="input"
                      defaultValue={form.notify_user_id ?? ''}
                    >
                      <option value="">Whoever ends up owning it</option>
                      {userList.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name || user.email}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </fieldset>

              <SubmitButton className="btn-primary w-full" pendingLabel="Saving…">
                Save settings
              </SubmitButton>
            </ActionForm>
          </Section>

          {context.canDelete && (
            <Section title="Delete">
              <form action={deleteForm} className="space-y-2">
                <input type="hidden" name="id" value={form.id} />
                <p className="text-xs text-slate-500">
                  The {form.submission_count} submission
                  {form.submission_count === 1 ? '' : 's'} behind this form go with it. The contacts
                  stay, but the evidence for their consent does not.
                </p>
                <button type="submit" className="btn-danger w-full">
                  Delete this form
                </button>
              </form>
            </Section>
          )}
        </div>
      </div>
    </>
  )
}
