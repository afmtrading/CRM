import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import { contactName, formatDate } from '@/lib/format'
import type { ContactRow, DuplicateGroupRow } from '@/lib/database.types'
import { EmptyState, PageHeader } from '@/components/ui'

import { mergeContactsAction } from '../../contacts/actions'

export const metadata = { title: 'Duplicates · FLO CRM' }

export const dynamic = 'force-dynamic'

/**
 * On-demand deduplication against existing records (PRD 6.7). The import path
 * has its own dedupe; this is the sweep over what is already in the system.
 */
export default async function DuplicatesPage() {
  const context = await requireSession()

  const { data: groups, error } = await context.supabase.rpc('find_duplicate_groups')
  const groupList = (groups ?? []) as DuplicateGroupRow[]

  const allIds = [...new Set(groupList.flatMap((group) => group.contact_ids))]

  const { data: contacts } = allIds.length
    ? await scoped(context, 'contacts').select('*').in('id', allIds)
    : { data: [] }

  const byId = new Map(((contacts ?? []) as ContactRow[]).map((contact) => [contact.id, contact]))

  return (
    <>
      <PageHeader
        title="Duplicate contacts"
        description="Contacts sharing an email address, or a name and phone number. Merging keeps the target record and moves the duplicate's deals, activities and tags onto it."
      />

      {error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error.message}
        </p>
      )}

      {groupList.length === 0 ? (
        <EmptyState
          title="No duplicates found"
          description="Every contact in this organization has a distinct email address and name/phone combination."
        />
      ) : (
        <div className="space-y-4">
          {groupList.map((group) => {
            const members = group.contact_ids
              .map((id) => byId.get(id))
              .filter((contact): contact is ContactRow => Boolean(contact))

            const [primary, ...rest] = members

            return (
              <div key={`${group.match_type}-${group.match_key}`} className="card overflow-hidden">
                <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                  <h2 className="text-sm font-medium text-slate-800">
                    {group.match_type === 'email' ? 'Same email' : 'Same name and phone'} ·{' '}
                    <code className="rounded bg-white px-1 text-xs">{group.match_key}</code>
                  </h2>
                  <span className="text-xs text-slate-500">{group.contact_count} records</span>
                </header>

                <table className="table">
                  <thead>
                    <tr>
                      <th>Contact</th>
                      <th>Email</th>
                      <th>Phone</th>
                      <th>Score</th>
                      <th>Created</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((contact) => (
                      <tr key={contact.id}>
                        <td>
                          <Link
                            href={`/contacts/${contact.id}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {contactName(contact)}
                          </Link>
                          {contact.id === primary?.id && (
                            <span className="badge ml-2 bg-slate-100 text-slate-600">oldest</span>
                          )}
                        </td>
                        <td className="text-slate-600">{contact.email ?? '—'}</td>
                        <td className="text-slate-600">{contact.phone ?? '—'}</td>
                        <td className="text-slate-600">{contact.lead_score}</td>
                        <td className="text-slate-500">{formatDate(contact.created_at)}</td>
                        <td className="text-right">
                          {contact.id !== primary?.id && primary && (
                            <form action={mergeContactsAction}>
                              <input type="hidden" name="target_id" value={primary.id} />
                              <input type="hidden" name="source_id" value={contact.id} />
                              <button type="submit" className="text-xs text-brand-700 hover:underline">
                                Merge into {contactName(primary)}
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {rest.length === 0 && (
                  <p className="px-4 py-2 text-xs text-slate-400">
                    Only one record is still active in this group.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
