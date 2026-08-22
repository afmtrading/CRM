import { formatDateTime } from '@/lib/format'
import { historyEntries } from '@/lib/document-history'
import type { HistoryLookups, HistoryRow } from '@/lib/document-history'

/**
 * What has been done to a document, newest first.
 *
 * This replaced two lines — created_by and updated_by — which is everything the
 * row itself stores. Edit an order five times and that showed the fifth; the
 * four before it were never anywhere. `document_history` records each change as
 * it happens, and this draws them.
 *
 * Bounded rather than paginated. A card in a sidebar is for the recent past;
 * somebody auditing a year of an order is doing a different job than the one
 * this card is on the page for.
 */
export function RecordHistory({
  rows,
  currency,
  lookups,
  limit = 40,
}: {
  rows: HistoryRow[]
  currency: string
  lookups: HistoryLookups
  limit?: number
}) {
  const entries = historyEntries(rows, currency, lookups)
  const shown = entries.slice(0, limit)

  if (shown.length === 0) {
    return <p className="text-sm text-slate-500">Nothing recorded yet.</p>
  }

  return (
    <>
      <ol className="max-h-96 space-y-3 overflow-y-auto text-sm">
        {shown.map((entry) => (
          <li key={entry.id} className="border-b border-slate-100 pb-3 last:border-0 last:pb-0">
            <p className="font-medium text-slate-900">{entry.label}</p>

            {entry.to !== null && (
              <p className="text-slate-600">
                <span className="text-slate-400 line-through">{entry.from}</span>
                <span className="mx-1.5 text-slate-300">→</span>
                <span>{entry.to}</span>
              </p>
            )}

            <p className="mt-0.5 text-xs text-slate-400">
              {entry.who} · {formatDateTime(entry.when)}
              {/*
                Said outright rather than left to be inferred. A backfilled row
                asserts that the document existed by then and nothing more —
                the changes before this table existed were never recorded and
                cannot be invented.
              */}
              {entry.assumed && ' · recorded before this history was kept'}
            </p>
          </li>
        ))}
      </ol>

      {entries.length > shown.length && (
        <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400">
          The {shown.length} most recent of {entries.length} changes.
        </p>
      )}
    </>
  )
}
