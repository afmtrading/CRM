'use client'

import { useRef, useState } from 'react'

import { MERGE_FIELDS, renderEmailBody } from '@/lib/email/render'
import { insertAt, prefixLine, wrapSelection, type EditResult } from '@/lib/markdown-edit'

/**
 * The message editor for a campaign.
 *
 * Markdown behind a toolbar rather than a contenteditable surface. What gets
 * stored is the text somebody typed, which is what makes the email safe to
 * build: renderEmailBody escapes the source *before* applying any formatting,
 * so a message can never carry markup of its own into somebody's inbox. A
 * rich-text surface would store HTML and force the opposite bargain — either
 * trust whatever the browser produced, or maintain a sanitiser.
 *
 * The toolbar is deliberately not the notes toolbar. It offers an Image button,
 * because an email can carry one, and no Code button, because renderEmailBody
 * has no rule for backticks and the recipient would see them.
 *
 * The preview runs the real renderer — the same function the sender calls — so
 * what is on screen is what goes out, rather than an approximation of it.
 */
export function CampaignMessageEditor({
  name = 'body',
  id = 'body',
  defaultValue = '',
  rows = 12,
  required = true,
}: {
  name?: string
  id?: string
  defaultValue?: string
  rows?: number
  required?: boolean
}) {
  const [value, setValue] = useState(defaultValue)
  const [preview, setPreview] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  /** Applies an edit and puts the caret back where the edit says it belongs. */
  function apply(edit: (value: string, start: number, end: number) => EditResult) {
    const el = ref.current
    if (!el) return

    const result = edit(value, el.selectionStart, el.selectionEnd)
    setValue(result.value)

    // After React has painted the new value, not before — setting the range on
    // the old text would put the caret at the wrong offset.
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(result.start, result.end)
    })
  }

  const buttons: { label: string; title: string; run: () => void; className?: string }[] = [
    {
      label: 'B',
      title: 'Bold',
      run: () => apply((v, s, e) => wrapSelection(v, s, e, '**')),
      className: 'font-bold',
    },
    {
      label: 'I',
      title: 'Italic',
      run: () => apply((v, s, e) => wrapSelection(v, s, e, '*')),
      className: 'italic',
    },
    {
      label: 'H',
      title: 'Heading',
      run: () => apply((v, s) => prefixLine(v, s, '## ')),
      className: 'font-semibold',
    },
    { label: '• List', title: 'Bullet list', run: () => apply((v, s) => prefixLine(v, s, '- ')) },
    {
      label: '1. List',
      title: 'Numbered list',
      run: () => apply((v, s) => prefixLine(v, s, '1. ')),
    },
    {
      label: 'Link',
      title: 'Link',
      run: () => apply((v, s, e) => wrapSelection(v, s, e, '[', '](https://)', 'link text')),
    },
    {
      label: 'Image',
      title: 'Image',
      run: () => apply((v, s, e) => wrapSelection(v, s, e, '![', '](https://)', 'alt text')),
    },
  ]

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        {buttons.map((button) => (
          <button
            key={button.label}
            type="button"
            title={button.title}
            onClick={button.run}
            disabled={preview}
            className={`rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 ${button.className ?? ''}`}
          >
            {button.label}
          </button>
        ))}

        {/* A fixed list, because the renderer's is fixed: a field it does not
            know is left visible in the message rather than blanked, so this
            offers only the four that will actually be filled in. */}
        <select
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 disabled:opacity-40"
          value=""
          disabled={preview}
          aria-label="Insert a merge field"
          onChange={(event) => {
            const field = event.target.value
            if (!field) return
            apply((v, s, e) => insertAt(v, s, e, `{{${field}}}`))
            event.target.value = ''
          }}
        >
          <option value="">Merge field…</option>
          {MERGE_FIELDS.map((field) => (
            <option key={field} value={field}>
              {field.replace(/_/g, ' ')}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setPreview(!preview)}
          className={`ml-auto rounded-lg border px-2 py-1 text-xs transition-colors ${
            preview
              ? 'border-brand-200 bg-brand-50 text-brand-700'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          {preview ? 'Write' : 'Preview'}
        </button>
      </div>

      {/* The textarea keeps its name and value while previewing rather than
          being unmounted, so switching to Preview and submitting still posts
          the message. */}
      <textarea
        ref={ref}
        id={id}
        name={name}
        required={required}
        rows={rows}
        className={`input font-mono text-[13px] leading-relaxed ${preview ? 'hidden' : ''}`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={'Hello {{first_name}},\n\nWe have new stock arriving next week…'}
      />

      {preview && (
        <div
          className="rounded-xl border border-slate-200 bg-white px-4 py-3"
          style={{ minHeight: `${rows * 1.6}rem` }}
        >
          {value.trim() ? (
            <div
              // Safe by construction: renderEmailBody escapes the source before
              // applying any formatting, so the only markup here is the markup
              // it generated. Merge fields are left as written — this preview
              // is of the message, not of one recipient's copy of it.
              dangerouslySetInnerHTML={{ __html: renderEmailBody(value) }}
            />
          ) : (
            <p className="text-sm text-slate-400">Nothing to preview yet.</p>
          )}
        </div>
      )}
    </div>
  )
}
