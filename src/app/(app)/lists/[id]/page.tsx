import Link from 'next/link'
import { notFound } from 'next/navigation'

import { firstRow, requireSession, scoped } from '@/lib/tenancy'
import { contactName } from '@/lib/format'
import { blockedLabel, CONSENT_LABELS } from '@/lib/consent'
import type {
  ContactMailabilityRow,
  ContactRow,
  EmailListRow,
  SavedFilterRow,
} from '@/lib/database.types'
import { EmptyState, ErrorNote, PageHeader, Section } from '@/components/ui'
import { DateTime } from '@/components/date-time'

import { deleteList, removeFromList } from '../actions'

export const metadata = { title: 'List · FLO CRM' }

export default async function ListDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string; ok?: string }>
}) {
  const { id } = await params
  const { error, ok } = await searchParams
  const context = await requireSession()

  const list = await firstRow<EmailListRow>(
    scoped(context, 'email_lists').select('*').eq('id', id).maybeSingle(),
  )

  if (!list) notFound()

  const [{ data: members }, { data: filter }] = await Promise.all([
    scoped(context, 'email_list_members')
      .select('contact_id, added_at')
      .eq('list_id', id)
      .order('added_at', { ascending: false }),
    list.saved_filter_id
      ? scoped(context, 'saved_filters').select('*').eq('id', list.saved_filter_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const memberRows = (members ?? []) as { contact_id: string; added_at: string }[]
  const contactIds = memberRows.map((row) => row.contact_id)

  /*
   * Mailability is read from the view rather than worked out here, so this
   * screen, the send loop and any later report all give the same answer to the
   * same question.
   */
  const [{ data: contacts }, { data: mailability }] = contactIds.length
    ? await Promise.all([
        scoped(context, 'contacts')
          .select('id, first_name, last_name, email, marketing_consent, consent_at, consent_source')
          .in('id', contactIds),
        scoped(context, 'contact_mailability').select('*').in('contact_id', contactIds),
      ])
    : [{ data: [] }, { data: [] }]

  const contactRows = (contacts ?? []) as Pick<
    ContactRow,
    'id' | 'first_name' | 'last_name' | 'email' | 'marketing_consent' | 'consent_at' | 'consent_source'
  >[]
  const byId = new Map(contactRows.map((contact) => [contact.id, contact]))
  const blockedBy = new Map(
    ((mailability ?? []) as ContactMailabilityRow[]).map((row) => [
      row.contact_id,
      row.blocked_reason,
    ]),
  )

  const mailable = contactRows.filter((contact) => !blockedBy.get(contact.id)).length
  const savedFilter = filter as SavedFilterRow | null

  return (
    <>
      <PageHeader
        title={list.name}
        description={list.description ?? undefined}
        actions={
          <>
            <Link href="/contacts" className="btn-secondary">
              Add contacts
            </Link>
            {context.canWrite && (
              <form action={deleteList}>
                <input type="hidden" name="id" value={list.id} />
                <button type="submit" className="btn-danger">
                  Delete list
                </button>
              </form>
            )}
          </>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {ok && (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          {ok}
        </p>
      )}

      <div className="mb-5 grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title={savedFilter ? 'This list follows a filter' : 'Who is on it'}>
            {savedFilter ? (
              <p className="text-sm text-slate-600">
                It re-reads{' '}
                <Link
                  href={`/contacts?view=${savedFilter.id}`}
                  className="text-brand-700 hover:underline"
                >
                  {savedFilter.name}
                </Link>{' '}
                every time you send, so it always reflects who matches today. Nothing is stored
                here.
              </p>
            ) : (
              <p className="text-sm text-slate-600">
                <strong>{contactRows.length}</strong>{' '}
                {contactRows.length === 1 ? 'contact' : 'contacts'}, of which{' '}
                <strong>{mailable}</strong> can be emailed right now.
              </p>
            )}
          </Section>
        </div>

        <Section title="Where they came from">
          <p className="text-sm text-slate-700">{list.source_note ?? '—'}</p>
          <p className="mt-2 text-xs text-slate-500">
            Recorded when the list was made. This is the record of why these people may be emailed.
          </p>
        </Section>
      </div>

      {savedFilter ? null : contactRows.length === 0 ? (
        <EmptyState
          title="Nobody on this list yet"
          description="Go to Contacts, tick some rows, and add them from the bar that appears."
          action={
            <Link href="/contacts" className="btn-primary">
              Choose contacts
            </Link>
          }
        />
      ) : (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>Contact</th>
                <th>Email</th>
                <th>Consent</th>
                <th>Basis</th>
                <th>Status</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {memberRows.map((member) => {
                const contact = byId.get(member.contact_id)
                if (!contact) return null
                const blocked = blockedLabel(blockedBy.get(contact.id))

                return (
                  <tr key={member.contact_id} className="hover:bg-slate-50">
                    <td>
                      <Link
                        href={`/contacts/${contact.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {contactName(contact)}
                      </Link>
                    </td>
                    <td className="text-slate-600">{contact.email ?? '—'}</td>
                    <td className="text-slate-600">
                      {CONSENT_LABELS[contact.marketing_consent]}
                    </td>
                    <td className="max-w-xs truncate text-slate-500" title={contact.consent_source ?? ''}>
                      {contact.consent_source ?? '—'}
                    </td>
                    <td>
                      {blocked ? (
                        <span className="text-amber-700">{blocked}</span>
                      ) : (
                        <span className="text-emerald-700">Can be emailed</span>
                      )}
                    </td>
                    <td className="text-slate-500">
                      <DateTime value={member.added_at} />
                    </td>
                    <td className="text-right">
                      {context.canWrite && (
                        <form action={removeFromList}>
                          <input type="hidden" name="list_id" value={list.id} />
                          <input type="hidden" name="contact_id" value={contact.id} />
                          <button
                            type="submit"
                            className="text-xs text-slate-400 hover:text-red-600"
                            aria-label={`Remove ${contactName(contact)} from ${list.name}`}
                          >
                            Remove
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
