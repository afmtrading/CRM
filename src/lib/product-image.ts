/**
 * The one photo a product may carry.
 *
 * Pure — the validation runs in the browser before an upload starts and again
 * on the server before one is accepted, from this same file, so the two can
 * never drift into disagreeing about what an acceptable image is.
 */

export const PRODUCT_IMAGE_BUCKET = 'product-images'

/** Matched by the bucket's own limit, which is what actually enforces it. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

/**
 * Why this file cannot be used, in words worth showing somebody.
 *
 * Null means it is fine. The type is checked rather than the extension: a
 * `.jpg` that is really a PDF would be refused by the bucket after the upload
 * had already been paid for, and the message would come back in Supabase's
 * words rather than in ours.
 */
export function describeImageProblem(file: { type: string; size: number }): string | null {
  if (!IMAGE_TYPES[file.type]) {
    return 'That is not an image the catalogue can show. Use a JPEG, PNG, WebP, GIF or AVIF.'
  }

  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1)
    return `That image is ${mb} MB. The limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`
  }

  // A zero-byte file is what an empty file input posts in some browsers, and
  // uploading it would leave a product showing a broken picture.
  if (file.size === 0) return 'That file is empty.'

  return null
}

/**
 * Where a product's photo lives.
 *
 * The organization comes first because the storage policies read that segment
 * to decide who may write here — it is a permission boundary, not tidiness.
 * The random segment is what stops a public URL being guessable from the
 * product id, and what lets a replacement upload land before the old one is
 * deleted.
 */
export function productImageKey(
  organizationId: string,
  productId: string,
  contentType: string,
  random: string,
): string {
  const extension = IMAGE_TYPES[contentType] ?? 'bin'
  return `${organizationId}/${productId}/${random}.${extension}`
}

/**
 * The public URL of a stored object.
 *
 * Built rather than stored: baking this project's hostname into every row
 * would leave a catalogue of dead links behind a restore or a move.
 */
export function productImageUrl(
  path: string | null | undefined,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
): string | null {
  if (!path || !supabaseUrl) return null
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${PRODUCT_IMAGE_BUCKET}/${path}`
}

/**
 * Whether a key belongs to an organization.
 *
 * The storage policies enforce this in the database; this is for the app, which
 * deletes the object a product used to point at and must never be talked into
 * deleting one belonging to somebody else by a tampered form field.
 */
export function keyBelongsTo(path: string | null | undefined, organizationId: string): boolean {
  if (!path) return false
  return path.split('/')[0] === organizationId
}
