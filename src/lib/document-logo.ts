/**
 * The organization's logo, as bytes the renderer can embed.
 *
 * Fetched here rather than handed to the PDF renderer as a URL, because the
 * renderer fetches it while drawing and throws if that fails — which turns a
 * logo somebody mistyped, or a host that is down this afternoon, into no
 * document at all. A purchase order without a logo is a purchase order. A
 * purchase order that will not download is an outage.
 *
 * So: every failure is null, and null simply draws no logo.
 */

/** Two megabytes. A letterhead is a few tens of kilobytes; more is a mistake. */
const MAX_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 3000

/**
 * The formats the renderer can actually embed.
 *
 * SVG is deliberately absent: @react-pdf/renderer does not rasterise it, and
 * passing one through produces a broken image rather than an error somebody
 * would notice.
 */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/jpg'])

export async function loadOrganizationLogo(url: string | null): Promise<string | null> {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return null

  /*
   * Only http(s). A `file:` or `data:` URL in this column would be somebody
   * asking the server to read its own disk, and the column is editable by any
   * administrator.
   */
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  try {
    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // The logo changes about never; letting the platform cache it keeps a
      // download from waiting on somebody else's CDN every time.
      cache: 'force-cache',
    })
    if (!response.ok) return null

    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!ALLOWED.has(type)) return null

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null

    const mime = type === 'image/jpg' ? 'image/jpeg' : type
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
  } catch {
    // Timed out, refused, DNS, malformed body. All of them mean the same thing
    // to this document.
    return null
  }
}
