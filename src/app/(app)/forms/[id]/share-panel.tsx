'use client'

import { useState } from 'react'

/**
 * The two ways a form leaves the CRM.
 *
 * A link, for an email or a social post, and an iframe for a page somebody
 * owns. There is deliberately no script tag: a script that injects markup
 * inherits the host page's CSS and breaks differently on every site it is
 * pasted into, needs CORS on the submit path, and asks a customer to run our
 * JavaScript on their page. The iframe renders the page we already serve.
 */
export function SharePanel({ url, snippet }: { url: string; snippet: string }) {
  return (
    <div className="space-y-4">
      <div>
        <span className="label">Link</span>
        <div className="flex flex-wrap items-center gap-2">
          <input readOnly value={url} className="input min-w-0 flex-1 font-mono text-xs" />
          <CopyButton value={url} label="Copy link" />
          <a href={url} target="_blank" rel="noreferrer" className="btn-secondary">
            Open
          </a>
        </div>
      </div>

      <div>
        <span className="label">Embed on a page</span>
        <textarea
          readOnly
          value={snippet}
          rows={5}
          className="input font-mono text-xs leading-relaxed"
        />
        <div className="mt-2">
          <CopyButton value={snippet} label="Copy embed code" />
        </div>
      </div>
    </div>
  )
}

/**
 * Copies, and says so for a moment.
 *
 * Falls back to selecting the text when the clipboard is refused — which is
 * what happens on a page served over plain http, and is exactly the situation
 * somebody testing this locally will be in.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this:', value)
    }
  }

  return (
    <button type="button" className="btn-secondary" onClick={copy}>
      {copied ? 'Copied' : label}
    </button>
  )
}
