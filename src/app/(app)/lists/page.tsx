import Link from 'next/link'

import { requireSession, scoped } from '@/lib/tenancy'
import type { EmailListRow, SavedFilterRow, UserRow } from '@/lib/database.types'
import { EmptyState, ErrorNote, PageHeader, Section } from '@/components/ui'
import { DateTime } from '@/components/date-time'

import { createList } from './actions'

export const metadata = { title: 'Lists · FLO CRM' }

export default async function ListsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>
}) {
  const { error, ok } = await searchParams
  const context = await requireSession()

  const [{ data: lists }, { data: counts }, { data: users }, { data: filters }] = await Promise.all([
    scoped(context, 'email_lists').select('*').order('created_at', { ascending: false }),
    scoped(context, 'email_list_members').select('list_id'),
    scoped(context, 'users').select('*').order('name'),
    scoped(context, 'saved_filters')
      .select('*')
      .eq('entity_type', 'contact')
      .order('name'),
  ])

  const listRows = (lists ?? []) as EmailListRow[]
  const userList = (users ?? []) as UserRow[]
  const savedFilters = (filters ?? []) as SavedFilterRow[]

  const memberCounts = new Map<string, number>()
  for (const row of (counts ?? []) as { list_id: string }[]) {
    memberCounts.set(row.list_id, (memberCounts.get(row.list_id) ?? 0) + 1)
  }

  const userName = (id: string | null) => {
    if (!id) return '—'
    const user = userList.find((candidate) => candidate.id === id)
    return user ? user.name || user.email : '—'
  }

  return (
    <>
      <PageHeader title="Lists" />

      {error && <ErrorNote>{error}</ErrorNote>}
      {ok && (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          {ok}
        </p>
      )}

      {context.canWrite && (
        <Section title="New list">
          <form action={createList} className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="name">
                Name
              </label>
              <input id="name" name="name" required maxLength={160} className="input" />
            </div>

            <div>
              <label className="label" htmlFor="saved_filter_id">
                Keep it up to date with
              </label>
              <select id="saved_filter_id" name="saved_filter_id" className="input">
                <option value="">A fixed set of people I choose</option>
                {savedFilters.map((filter) => (
                  <option key={filter.id} value={filter.id}>
                    {filter.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">
                Pick a saved contact filter and the list re-reads it every time you send.
              </p>
            </div>

            {/*
              Required, and the reason the whole feature exists in this order.
              Recorded while somebody still remembers; reconstructing it later is
              the expensive version.
            */}
            <div className="sm:col-span-2">
              <label className="label" htmlFor="source_note">
                Where did these contacts come from?
              </label>
              <input
                id="source_note"
                name="source_note"
                required
                maxLength={2000}
                className="input"
                placeholder="Existing customers · Trade show, Toronto, March 2026 · Signed up on the website"
              />
              <p className="mt-1 text-xs text-slate-500">
                This is the record of why these people may be emailed. One sentence is enough.
              </p>
            </div>

            <div className="sm:col-span-2">
              <label className="label" htmlFor="description">
                Notes (optional)
              </label>
              <input id="description" name="description" maxLength={2000} className="input" />
            </div>

            <div className="sm:col-span-2">
              <button type="submit" className="btn-primary">
                Create list
              </button>
            </div>
          </form>
        </Section>
      )}

      <div className="mt-5">
        {listRows.length === 0 ? (
          <EmptyState
            title="No lists yet"
            description="Make one above, then add contacts to it from the contacts page."
          />
        ) : (
          <div className="card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>List</th>
                  <th>Kind</th>
                  <th>Contacts</th>
                  <th>Source</th>
                  <th>Created by</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {listRows.map((list) => (
                  <tr key={list.id} className="hover:bg-slate-50">
                    <td>
                      <Link
                        href={`/lists/${list.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {list.name}
                      </Link>
                      {list.description && (
                        <span className="ml-2 text-xs text-slate-400">{list.description}</span>
                      )}
                    </td>
                    <td className="text-slate-600">
                      {list.saved_filter_id ? 'Filter' : 'Fixed'}
                    </td>
                    <td className="text-slate-600">
                      {list.saved_filter_id ? '—' : (memberCounts.get(list.id) ?? 0)}
                    </td>
                    <td className="max-w-xs truncate text-slate-500" title={list.source_note ?? ''}>
                      {list.source_note ?? '—'}
                    </td>
                    <td className="text-slate-600">{userName(list.created_by)}</td>
                    <td className="text-slate-500">
                      <DateTime value={list.created_at} />
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
