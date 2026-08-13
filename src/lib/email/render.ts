/**
 * Turning a written message into an email.
 *
 * Not the same job as rendering markdown for the app, which is why this does
 * not reuse `renderMarkdown`. Email clients are twenty years behind browsers:
 * Outlook ignores most of a `<style>` block, Gmail strips it on forwarding,
 * and class names mean nothing anywhere. So every rule is inlined on the
 * element it applies to, the layout is one column with a width in pixels, and
 * nothing depends on CSS that a 2003 rendering engine would not recognise.
 *
 * Every message goes out as both HTML and plain text. The text part is not a
 * fallback nobody sees — spam filters read it, some people prefer it, and a
 * message with no text alternative scores worse for that reason alone.
 */

export interface EmailContent {
  subject: string
  /** The body, written as markdown. */
  body: string
  /** Absolute URL of a logo to sit above the message, if there is one. */
  logoUrl?: string | null
  /** Where the unsubscribe link points. Required — see the footer below. */
  unsubscribeUrl: string
  /** Required in marketing email by US law, and good manners everywhere. */
  postalAddress?: string | null
  /**
   * The name the recipient knows the sender by — the From name, not the
   * organization's internal label. A footer reading "you are a contact of AFM
   * CRM" when the message came from Flo Ventures is confusing at best and
   * reads as a mismatched sender at worst, which is what filters look for.
   */
  organizationName: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Only http(s) survives. A `javascript:` link in an email is not a link. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

const LINK = 'color:#1b6b47;text-decoration:underline'

/**
 * Bold, italic, underline, links and images, applied after the text has been
 * escaped.
 *
 * `__underline__` is this app's own spelling. Standard markdown reads it as a
 * second way to write bold, which is a redundancy nobody needs, and there is no
 * standard spelling for underline at all — so the slot is put to use. Worth
 * knowing that on the web an underline reads as a link, so it earns its place
 * on a heading or a signature and rarely in a sentence.
 */
function inline(source: string): string {
  let html = escapeHtml(source)

  // Images before links: the syntax differs by one leading character, and a
  // link pattern applied first would swallow them.
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt: string, url: string) => {
    const href = safeHref(url)
    if (!href) return alt
    return `<img src="${href}" alt="${alt}" style="max-width:100%;height:auto;display:block;border:0" />`
  })

  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, url: string) => {
    const href = safeHref(url)
    return href ? `<a href="${href}" style="${LINK}">${text}</a>` : text
  })

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  // After bold, so that `**__both__**` survives in either order.
  html = html.replace(/__([^_]+)__/g, '<u>$1</u>')

  return html
}

const P = 'margin:0 0 16px;font-size:15px;line-height:1.6;color:#1f2937'
/** The same rules without the bottom margin, for list items that set their own. */
const LI = 'font-size:15px;line-height:1.6;color:#1f2937;margin:0 0 6px'

/**
 * The message as plain text, with the markdown taken out rather than left in.
 *
 * The text part is what somebody reading in a text-only client sees, and what
 * a spam filter reads when it compares the two halves of a multipart message.
 * Leaving `**Bold**` and `[Links](https://…)` in it looks unfinished to the
 * first and scores badly with the second — the words are the content, the
 * syntax was only ever instructions for the renderer.
 */
export function markdownToText(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => {
      // Alignment first: it sits in front of everything else on the line, and
      // a plain-text reader has no columns to align anything in.
      let text = line.replace(/^::(?:left|center|right)\s+/, '')
      text = text.replace(/^(#{1,4})\s+/, '')
      // An image has nothing to show in text; its alt text is the whole point.
      text = text.replace(/!\[([^\]]*)\]\([^)\s]+\)/g, '$1')
      // A link keeps its address, in brackets, because a text reader cannot click.
      text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
      text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
      text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
      text = text.replace(/__([^_]+)__/g, '$1')
      return text
    })
    .join('\n')
}

/** Heading sizes, largest first. Four levels, matching the toolbar. */
const HEADING_SIZES = [26, 22, 18, 16]

/**
 * The message body, as inline-styled HTML.
 *
 * Headings, bullets, numbered lists, links, images, and one line prefix for
 * alignment — `::center Some text` — because markdown has no spelling for
 * alignment and an email frequently needs one.
 *
 * Every list carries its `list-style-type` inline rather than relying on the
 * browser default. Two reasons, and the first is the one that bit: this HTML is
 * also shown in the app's own preview, where the CSS reset sets
 * `list-style: none` on every list — so bullets and numbers vanished from the
 * preview while the real email kept them, which is exactly the sort of
 * disagreement a preview exists to prevent. The second is that email clients
 * reset things unpredictably too.
 */
export function renderEmailBody(source: string): string {
  const lines = source.split(/\r?\n/)
  const html: string[] = []
  let list: 'ul' | 'ol' | null = null

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`)
      list = null
    }
  }

  for (const line of lines) {
    let trimmed = line.trim()

    if (!trimmed) {
      closeList()
      continue
    }

    // Alignment is read and stripped before anything else, so `::center ## Hi`
    // is a centred heading rather than a paragraph starting with a hash.
    let align = ''
    const aligned = /^::(left|center|right)\s+(.*)$/.exec(trimmed)
    if (aligned) {
      // Left is the default; saying so in a style attribute would only be
      // noise in the message source.
      if (aligned[1] !== 'left') align = `;text-align:${aligned[1]}`
      trimmed = aligned[2]
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (heading) {
      closeList()
      const size = HEADING_SIZES[heading[1].length - 1]
      html.push(
        `<p style="margin:0 0 12px;font-size:${size}px;line-height:1.3;font-weight:600;color:#111827${align}">${inline(
          heading[2],
        )}</p>`,
      )
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet) {
      if (list !== 'ul') {
        closeList()
        html.push('<ul style="margin:0 0 16px;padding-left:22px;list-style-type:disc">')
        list = 'ul'
      }
      html.push(`<li style="${LI}${align}">${inline(bullet[1])}</li>`)
      continue
    }

    // The written numbers are not used: `<ol>` counts, so 1. 1. 1. and
    // 1. 2. 3. both come out as one, two, three. That is the point of an
    // ordered list — inserting a line in the middle must not mean renumbering
    // the rest by hand.
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed)
    if (numbered) {
      if (list !== 'ol') {
        closeList()
        html.push('<ol style="margin:0 0 16px;padding-left:22px;list-style-type:decimal">')
        list = 'ol'
      }
      html.push(`<li style="${LI}${align}">${inline(numbered[1])}</li>`)
      continue
    }

    closeList()
    html.push(`<p style="${P}${align}">${inline(trimmed)}</p>`)
  }

  closeList()
  return html.join('\n')
}

/**
 * The whole message.
 *
 * The footer is not optional and is not configurable away. An unsubscribe link
 * that works is what separates marketing email from spam — legally in most
 * places, and in the judgement of every filter everywhere. Building it into the
 * renderer rather than the template means no campaign can be sent without one.
 */
export function renderEmail(content: EmailContent): RenderedEmail {
  const logo = content.logoUrl ? safeHref(content.logoUrl) : null
  const unsubscribe = safeHref(content.unsubscribeUrl)

  if (!unsubscribe) {
    throw new Error('An email needs a working unsubscribe link')
  }

  const body = renderEmailBody(content.body)

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f5;-webkit-font-smoothing:antialiased">
<!-- Shown in the inbox list under the subject, so it says something rather
     than repeating the first line of the message. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(
    content.subject,
  )}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6f5">
  <tr>
    <td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:10px;border:1px solid #e2e8f0">
        ${
          logo
            ? `<tr><td style="padding:24px 28px 0"><img src="${logo}" alt="${escapeHtml(
                content.organizationName,
              )}" style="max-height:40px;border:0" /></td></tr>`
            : ''
        }
        <tr>
          <td style="padding:24px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 24px">
            <hr style="border:0;border-top:1px solid #e2e8f0;margin:0 0 16px" />
            <p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
              You received this because you are a contact of ${escapeHtml(
                content.organizationName,
              )}.
              <a href="${unsubscribe}" style="color:#64748b;text-decoration:underline">Unsubscribe</a>
            </p>
            ${
              content.postalAddress
                ? `<p style="margin:0;font-size:12px;line-height:1.5;color:#94a3b8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${escapeHtml(
                    content.postalAddress,
                  )}</p>`
                : ''
            }
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  const text = [
    markdownToText(content.body).trim(),
    '',
    '—',
    `You received this because you are a contact of ${content.organizationName}.`,
    `Unsubscribe: ${unsubscribe}`,
    content.postalAddress ?? '',
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n')
    .trim()

  return { subject: content.subject, html, text }
}

/**
 * Fills in the merge fields a template may use.
 *
 * A fixed list rather than anything a template can name: a campaign should not
 * be able to reach into arbitrary columns, and a typo should leave a visible
 * gap rather than a blank the writer never notices. An unknown field is left
 * as it was written, so `{{fist_name}}` arrives looking wrong instead of
 * silently disappearing.
 */
export function applyMergeFields(source: string, values: Record<string, string | null>): string {
  return source.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key: string) => {
    const value = values[key.toLowerCase()]
    return value === undefined ? whole : (value ?? '')
  })
}

export const MERGE_FIELDS = ['first_name', 'last_name', 'company', 'email'] as const
