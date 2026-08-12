import 'server-only'

import { applyFilter, parseFilterConfig } from '@/lib/filters'
import { scoped, type SessionContext } from '@/lib/tenancy'
import type { EmailListRow, SavedFilterRow } from '@/lib/database.types'

/**
 * Turning a list into the people it currently means.
 *
 * Separate from `campaigns.ts` because this one needs a database, and the
 * arithmetic next door should stay testable without one.
 */

/** PostgREST caps a response; an audience of thousands has to be walked. */
const PAGE = 1000

/**
 * Every contact a list currently resolves to.
 *
 * Both kinds of list end up here, which is the point: a static list is read
 * from its members, a dynamic one by re-running its saved filter, and the
 * caller does not have to care which it was given. Whether any of these people
 * may actually be emailed is not decided here — that stays in the database,
 * where one definition serves this screen, the send loop and every later
 * report.
 */
export async function resolveListContactIds(
  context: SessionContext,
  list: EmailListRow,
): Promise<string[]> {
  if (list.saved_filter_id) {
    const { data: filterRow } = await scoped(context, 'saved_filters')
      .select('*')
      .eq('id', list.saved_filter_id)
      .maybeSingle()

    const filter = filterRow as SavedFilterRow | null
    // A filter that has been deleted resolves to nobody rather than to
    // everybody. The failure mode of the other choice is a mail-out to the
    // entire database.
    if (!filter) return []

    const config = parseFilterConfig(filter.filter_json)
    const ids: string[] = []

    for (let from = 0; ; from += PAGE) {
      let query = scoped(context, 'contacts')
        .select('id')
        .is('deleted_at', null)
        .is('duplicate_of_id', null)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query = applyFilter(query as any, config, 'contact') as any

      const { data } = await query.range(from, from + PAGE - 1)
      const rows = (data ?? []) as { id: string }[]
      ids.push(...rows.map((row) => row.id))

      if (rows.length < PAGE) break
    }

    return ids
  }

  const ids: string[] = []
  for (let from = 0; ; from += PAGE) {
    const { data } = await scoped(context, 'email_list_members')
      .select('contact_id')
      .eq('list_id', list.id)
      .range(from, from + PAGE - 1)

    const rows = (data ?? []) as { contact_id: string }[]
    ids.push(...rows.map((row) => row.contact_id))

    if (rows.length < PAGE) break
  }

  return ids
}

