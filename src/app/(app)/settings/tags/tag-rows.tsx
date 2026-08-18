'use client'

import { useActionState, useEffect, useState } from 'react'

import { deleteTag, updateTag } from '../actions'
import type { ActionState } from '@/components/action-form'

export interface TagUsage {
  id: string
  name: string
  color: string
  contacts: number
  companies: number
  products: number
}

/**
 * The tag list, with a way to change one.
 *
 * Editing existed only as delete-and-recreate, which is not the same operation:
 * the new tag is a new row, and everything carrying the old one loses it. A
 * rename should cost nothing, and here it costs nothing — the id does not move,
 * so every contact, company and product keeps the tag.
 *
 * One row at a time is editable. A page of open inputs invites somebody to
 * change four things and save one.
 */
/**
 * One tag being edited.
 *
 * Its own component because useActionState is a hook, and the row it belongs to
 * is produced inside a map. Extracting it is what lets the refusal — "The tag
 * \"VIP\" already exists." — have somewhere to land.
 *
 * The editor closes on success rather than on submit. Closing on submit is what
 * it used to do, which threw the message away at the moment it was written.
 */
function TagEditRow({
  tag,
  used,
  setEditing,
}: {
  tag: TagUsage
  used: number
  setEditing: (id: string | null) => void
}) {
  const [state, formAction, pending] = useActionState(updateTag, {} as ActionState)

  useEffect(() => {
    if (state.ok) setEditing(null)
  }, [state.ok, setEditing])

  return (
    <li className="py-3">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={tag.id} />
        <div className="min-w-40 flex-1">
          <label className="label" htmlFor={`tag-name-${tag.id}`}>
            Name
          </label>
          <input
            id={`tag-name-${tag.id}`}
            name="name"
            required
            autoFocus
            defaultValue={tag.name}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor={`tag-color-${tag.id}`}>
            Colour
          </label>
          <input
            id={`tag-color-${tag.id}`}
            name="color"
            type="color"
            defaultValue={tag.color}
            className="input h-9 w-16 py-1"
          />
        </div>
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </form>

      {state.error && (
        <p role="status" className="mt-2 text-xs text-red-700">
          {state.error}
        </p>
      )}

      {used > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Renaming keeps this tag on all {used} record{used === 1 ? '' : 's'} that carry it.
        </p>
      )}
    </li>
  )
}

export function TagRows({ tags }: { tags: TagUsage[] }) {
  const [editing, setEditing] = useState<string | null>(null)

  if (tags.length === 0) {
    return <p className="text-sm text-slate-500">No tags yet.</p>
  }

  return (
    <ul className="divide-y divide-slate-100">
      {tags.map((tag) => {
        const used = tag.contacts + tag.companies + tag.products

        if (editing === tag.id) {
          return <TagEditRow key={tag.id} tag={tag} used={used} setEditing={setEditing} />
        }

        return (
          <li key={tag.id} className="flex items-center justify-between gap-3 py-2">
            <span className="flex min-w-0 items-center gap-2 text-sm text-slate-800">
              <span
                className="inline-block h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: tag.color }}
                aria-hidden
              />
              <span className="truncate">{tag.name}</span>
              {/*
                All three, because a tag is one vocabulary across the records
                that use it. Counting only contacts made a tag on forty
                companies read as unused, and unused is what somebody deletes.
              */}
              <span className="shrink-0 text-xs text-slate-400">
                {used === 0
                  ? 'unused'
                  : [
                      tag.contacts && `${tag.contacts} contact${tag.contacts === 1 ? '' : 's'}`,
                      tag.companies && `${tag.companies} compan${tag.companies === 1 ? 'y' : 'ies'}`,
                      tag.products && `${tag.products} product${tag.products === 1 ? '' : 's'}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
              </span>
            </span>

            <span className="flex shrink-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setEditing(tag.id)}
                className="text-xs text-slate-500 hover:text-brand-700"
              >
                Edit
              </button>
              <form action={deleteTag}>
                <input type="hidden" name="id" value={tag.id} />
                <button type="submit" className="text-xs text-slate-400 hover:text-red-600">
                  Delete
                </button>
              </form>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
