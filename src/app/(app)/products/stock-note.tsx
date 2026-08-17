'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import { setStockNote } from './actions'

/**
 * One location's note, edited where it is read.
 *
 * The Adjust editor already sets these, but it opens the whole stock table for
 * editing — locations, bins, quantities and all — which is a lot of exposed
 * surface for the thing people actually do most often, which is write down that
 * a pallet arrived damaged. This is that one field, in the cell it lives in.
 *
 * Reading is the default state and stays a paragraph, so the table looks like a
 * table rather than a form. It becomes an input only once somebody asks.
 */
export function StockNote({
  productId,
  locationId,
  binId,
  note,
  canEdit,
}: {
  productId: string
  locationId: string
  binId: string | null
  note: string | null
  canEdit: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(note ?? '')
  const [pending, startTransition] = useTransition()
  const input = useRef<HTMLTextAreaElement>(null)

  /*
   * The server is the authority. A revalidate after somebody else's save — or
   * after our own — arrives as a new `note` prop, and the draft has to follow
   * it rather than sit on a stale value it captured when the component mounted.
   */
  useEffect(() => {
    if (!editing) setValue(note ?? '')
  }, [note, editing])

  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing])

  if (!canEdit) {
    return note ? (
      <span className="whitespace-pre-wrap">{note}</span>
    ) : (
      <span className="text-slate-300">—</span>
    )
  }

  function save() {
    setEditing(false)

    // Nothing to say to the server about a note nobody changed.
    if (value.trim() === (note ?? '').trim()) {
      setValue(note ?? '')
      return
    }

    const body = new FormData()
    body.set('product_id', productId)
    body.set('location_id', locationId)
    if (binId) body.set('bin_id', binId)
    body.set('note', value)

    startTransition(async () => {
      await setStockNote(body)
    })
  }

  if (editing) {
    return (
      <textarea
        ref={input}
        rows={2}
        maxLength={500}
        className="input w-full text-sm"
        placeholder="Damaged pallet, recount pending…"
        value={value}
        aria-label="Note for this location"
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          /*
           * Enter saves and Escape abandons, which is what a one-line field in
           * a table is expected to do. Shift+Enter is left alone so a note can
           * still have two lines in it.
           */
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            save()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setValue(note ?? '')
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      /*
       * Full width and left-aligned so the click target is the cell rather than
       * the handful of characters in it — an empty note is the one most in need
       * of being clicked, and a dash is a very small thing to hit.
       */
      className={`-mx-1 block w-full rounded px-1 py-0.5 text-left whitespace-pre-wrap hover:bg-brand-50 ${
        pending ? 'opacity-50' : ''
      }`}
      title="Click to edit this location's note"
    >
      {value ? value : <span className="text-slate-300">—</span>}
    </button>
  )
}
