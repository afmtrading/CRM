'use client'

import { useEffect, useRef, useState } from 'react'

import { CONSENT_OPTIONS } from '@/lib/consent'
import { addContactsToList, recordConsent } from '@/app/(app)/lists/actions'

/**
 * The two things you do to a selection of contacts before you can email them:
 * say on what basis they may be mailed, and put them on a list.
 *
 * Sits inside the same form as the bulk-edit bar and reads the same `ids`
 * checkboxes, so one selection serves all three actions rather than each
 * needing its own.
 */
export function ConsentBar({ lists }: { lists: { id: string; name: string }[] }) {
  const [selected, setSelected] = useState(0)
  const [consent, setConsent] = useState(CONSENT_OPTIONS[0].value)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const form = ref.current?.closest('form')
    if (!form) return

    const count = () =>
      setSelected(form.querySelectorAll<HTMLInputElement>('input[name="ids"]:checked').length)

    count()
    form.addEventListener('change', count)
    return () => form.removeEventListener('change', count)
  }, [])

  const option = CONSENT_OPTIONS.find((entry) => entry.value === consent)

  return (
    <div ref={ref}>
      {selected > 0 && (
        <div className="card mb-3 space-y-3 border-slate-200 bg-slate-50 p-3">
          {/*
            Consent first. It is the answer to "may we email these people",
            and a list of people nobody may email is not an audience.
          */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-800">Record consent</span>

            <label className="sr-only" htmlFor="consent-basis">
              Consent basis
            </label>
            <select
              id="consent-basis"
              name="consent"
              className="input w-44 py-1.5 text-sm"
              value={consent}
              onChange={(event) =>
                setConsent(event.target.value as (typeof CONSENT_OPTIONS)[number]['value'])
              }
            >
              {CONSENT_OPTIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>

            {/* Meaningless for "no consent", so it is not asked for. */}
            {consent !== 'none' && (
              <input
                name="source"
                className="input w-72 py-1.5 text-sm"
                placeholder="Where from? — Existing customer, trade show, signed up…"
                aria-label="Where the consent came from"
              />
            )}

            <button
              type="submit"
              formAction={recordConsent}
              className="btn-secondary px-3 py-1.5 text-sm"
            >
              Record on {selected}
            </button>
          </div>

          {option && <p className="text-xs text-slate-500">{option.hint}</p>}

          {lists.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
              <span className="text-sm font-medium text-slate-800">Add to list</span>

              <label className="sr-only" htmlFor="list-id">
                List
              </label>
              <select id="list-id" name="list_id" className="input w-56 py-1.5 text-sm">
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>

              <button
                type="submit"
                formAction={addContactsToList}
                className="btn-secondary px-3 py-1.5 text-sm"
              >
                Add {selected}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
