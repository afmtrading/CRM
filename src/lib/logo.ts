/**
 * The organization's logo: where it lives and what may be one.
 *
 * A module of its own rather than constants inside the action, because a
 * 'use server' file may only export async functions — and because the one
 * function here decides what gets *deleted*, which is not something to leave
 * untested inside an action that needs a session and a bucket to run.
 */

export const LOGO_BUCKET = 'org-logos'

/** Two megabytes, matching the limit the bucket itself enforces. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024

/**
 * What the PDF renderer can embed, and the extension each gets.
 *
 * An SVG uploads happily and then draws nothing, which is the kind of failure
 * somebody discovers while holding a printed letterhead with a hole in it.
 */
export const LOGO_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

/** Where in the bucket a new logo for this organization goes. */
export function logoObjectKey(organizationId: string, extension: string, stamp: number): string {
  /*
   * The organization's own folder, which is what the bucket's policies check,
   * and a fresh name every time. Overwriting one key would leave the old image
   * cached at the same URL — on a CDN, in an email client — for as long as
   * each of them felt like keeping it.
   */
  return `${organizationId}/logo-${stamp}.${extension}`
}

/**
 * The object key inside our own bucket, or null for a URL somebody pasted.
 *
 * Used to clear up the previous file when a logo is replaced. Anything not
 * recognisably ours returns null and is left alone: a URL pointing at somebody
 * else's CDN is not this application's to delete, and neither is one pointing
 * at a different bucket in the same project.
 */
export function logoObjectPath(url: string | null | undefined): string | null {
  if (!url) return null

  const marker = `/storage/v1/object/public/${LOGO_BUCKET}/`
  const at = url.indexOf(marker)
  if (at === -1) return null

  const path = url.slice(at + marker.length).split('?')[0].split('#')[0]
  if (path === '') return null

  /*
   * Decoding can throw on a malformed escape ("%zz"), and a logo URL that
   * cannot be parsed is one we decline to delete rather than one we guess at.
   */
  try {
    return decodeURIComponent(path) || null
  } catch {
    return null
  }
}
