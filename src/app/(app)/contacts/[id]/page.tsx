import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import { contactName, formatCurrency, formatDate } from '@/lib/format'
import type {
  ActivityRow,
  ContactRow,
  DealRow,
  TagRow,
  UserRow,
} from '@/lib/database.types'
import { ActivityComposer, ActivityTimeline } from '@/components/activity-timeline'
import { DealStatusBadge, LifecycleBadge, PageHeader, Section } from '@/components/ui'

import { deleteContact, mergeContactsAction, setContactTags } from '../actions'

export default async function ContactDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ merged?: string }>
}) {
  const { id } = await params
  const { merged } = await searchParams
  const context = await requireSession()

  const contact = await firstRow<ContactRow & { companies: { id: string; name: string } | null }>(
    scoped(context, 'contacts').select('*, companies(id, name)').eq('id', id).maybeSingle(),
  )

  if (!contact) notFound()

  const [
    { data: activities },
    { data: deals },
    { data: users },
    { data: tags },
    { data: contactTags },
    { data: duplicates },
  ] = await Promise.all([
    scoped(context, 'activities')
      .select('*')
      .eq('related_to_type', 'contact')
      .eq('related_to_id', id)
      .order('occurred_at', { ascending: false })
      .limit(100),
    scoped(context, 'deals').select('*, stages(name)').eq('contact_id', id).order('created_at', { ascending: false }),
    scoped(context, 'users').select('*').eq('status', 'active').order('name'),
    scoped(context, 'tags').select('*').order('name'),
    scoped(context, 'contact_tags').select('tag_id').eq('contact_id', id),
    context.supabase.rpc('find_duplicate_contacts', {
      p_email: contact.email,
      p_first_name: contact.first_name,
      p_last_name: contact.last_name,
      p_phone: contact.phone,
      p_exclude_id: contact.id,
    }),
  ])

  const duplicateList = (duplicates ?? []) as ContactRow[]

  const userList = (users ?? []) as UserRow[]
  const tagList = (tags ?? []) as TagRow[]
  const selectedTagIds = new Set(((contactTags ?? []) as { tag_id: string }[]).map((t) => t.tag_id))
  const owner = userList.find((user) => user.id === contact.owner_id)
  const customFields = Object.entries((contact.custom_fields ?? {}) as Record<string, unknown>)
  const dealRows = (deals ?? []) as (DealRow & { stages: { name: string } | null })[]

  return (
    <>
      <PageHeader
        title={contactName(contact)}
        description={[contact.email, contact.phone].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            <Link href={`/contacts/${id}/edit`} className="btn-secondary">
              Edit
            </Link>
            <form action={deleteContact}>
              <input type="hidden" name="id" value={id} />
              <button type="submit" className="btn-danger">
                Delete
              </button>
            </form>
          </>
        }
      />

      {merged && (
        <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Contacts merged. Deals and activities from the duplicate now live here.
        </p>
      )}

      {contact.duplicate_of_id && (
        <p className="mb-4 rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-700">
          This record was merged into{' '}
          <Link href={`/contacts/${contact.duplicate_of_id}`} className="font-medium text-brand-700 hover:underline">
            another contact
          </Link>
          . It is kept so existing links still resolve.
        </p>
      )}

      {/* Merge flow (PRD 6.2): fold a duplicate into this record. */}
      {duplicateList.length > 0 && !contact.duplicate_of_id && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Possible duplicate{duplicateList.length === 1 ? '' : 's'} of this contact
          </p>
          <ul className="mt-2 space-y-2">
            {duplicateList.map((duplicate) => (
              <li key={duplicate.id} className="flex flex-wrap items-center gap-3 text-sm">
                <Link href={`/contacts/${duplicate.id}`} className="font-medium text-brand-700 hover:underline">
                  {contactName(duplicate)}
                </Link>
                <span className="text-slate-500">{duplicate.email ?? duplicate.phone ?? ''}</span>
                <form action={mergeContactsAction}>
                  <input type="hidden" name="target_id" value={id} />
                  <input type="hidden" name="source_id" value={duplicate.id} />
                  <button type="submit" className="btn-secondary py-1">
                    Merge into this contact
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Section title="Activity">
            <ActivityComposer
              relatedToType="contact"
              relatedToId={id}
              users={userList}
              currentUserId={context.user.id}
            />
            <div className="mt-4 border-t border-slate-100 pt-2">
              <ActivityTimeline
                activities={(activities ?? []) as ActivityRow[]}
                users={userList}
                returnTo={`/contacts/${id}`}
                emptyMessage="No calls, emails, meetings, notes or tasks logged for this contact yet."
              />
            </div>
          </Section>

          <Section
            title="Deals"
            actions={
              <Link href={`/deals/new?contact_id=${id}`} className="btn-secondary py-1">
                New deal
              </Link>
            }
          >
            {dealRows.length === 0 ? (
              <p className="text-sm text-slate-500">No deals linked to this contact.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Deal</th>
                    <th>Stage</th>
                    <th>Value</th>
                    <th>Status</th>
                    <th>Expected close</th>
                  </tr>
                </thead>
                <tbody>
                  {dealRows.map((deal) => (
                    <tr key={deal.id}>
                      <td>
                        <Link href={`/deals/${deal.id}`} className="font-medium text-brand-700 hover:underline">
                          {deal.name}
                        </Link>
                      </td>
                      <td>{deal.stages?.name ?? '—'}</td>
                      <td>{formatCurrency(deal.value, deal.currency)}</td>
                      <td>
                        <DealStatusBadge status={deal.status} />
                      </td>
                      <td>{formatDate(deal.expected_close_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>

        <div className="space-y-5">
          <Section title="Details">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Lifecycle stage</dt>
                <dd className="mt-0.5">
                  <LifecycleBadge stage={contact.lifecycle_stage} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Lead score</dt>
                <dd className="mt-0.5 font-medium text-slate-900">{contact.lead_score}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Company</dt>
                <dd className="mt-0.5">
                  {contact.companies ? (
                    <Link href={`/companies/${contact.companies.id}`} className="text-brand-700 hover:underline">
                      {contact.companies.name}
                    </Link>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Owner</dt>
                <dd className="mt-0.5 text-slate-800">{owner ? owner.name || owner.email : '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Source</dt>
                <dd className="mt-0.5 text-slate-800">{contact.source ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Created</dt>
                <dd className="mt-0.5 text-slate-800">{formatDate(contact.created_at)}</dd>
              </div>
              {customFields.map(([key, value]) => (
                <div key={key}>
                  <dt className="text-xs text-slate-500">{key}</dt>
                  <dd className="mt-0.5 text-slate-800">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title="Tags">
            {tagList.length === 0 ? (
              <p className="text-sm text-slate-500">
                No tags defined yet.{' '}
                {context.isAdmin && (
                  <Link href="/settings/tags" className="text-brand-700 hover:underline">
                    Create some
                  </Link>
                )}
              </p>
            ) : (
              <form action={setContactTags} className="space-y-2">
                <input type="hidden" name="contact_id" value={id} />
                <div className="flex flex-wrap gap-2">
                  {tagList.map((tag) => (
                    <label
                      key={tag.id}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        name="tag_ids"
                        value={tag.id}
                        defaultChecked={selectedTagIds.has(tag.id)}
                        className="rounded border-slate-300"
                      />
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: tag.color }}
                        aria-hidden
                      />
                      {tag.name}
                    </label>
                  ))}
                </div>
                <button type="submit" className="btn-secondary">
                  Save tags
                </button>
              </form>
            )}
          </Section>
        </div>
      </div>
    </>
  )
}
