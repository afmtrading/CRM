'use client'

import { useState } from 'react'

import { MAX_IMAGE_BYTES, describeImageProblem } from '@/lib/product-image'

/**
 * The one photo a product carries.
 *
 * Validated here as well as on the server and again by the bucket, from the
 * same rules — three checks rather than one because each catches it at a
 * different cost. This one is the cheapest: somebody who picks a 40 MB RAW file
 * is told so instantly instead of after uploading it over a phone connection.
 *
 * The preview is an object URL of the chosen file, so what is on screen is the
 * file that will be sent rather than a guess about it.
 */
export function ProductImageField({ currentUrl }: { currentUrl: string | null }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)

  const showing = preview ?? (removing ? null : currentUrl)

  function choose(file: File | undefined) {
    setProblem(null)

    if (!file || file.size === 0) {
      setPreview(null)
      return
    }

    const trouble = describeImageProblem(file)
    if (trouble) {
      setProblem(trouble)
      setPreview(null)
      return
    }

    // Choosing a replacement is not removing: the new file wins either way, and
    // leaving the flag set would delete the upload that had just replaced it.
    setRemoving(false)
    setPreview(URL.createObjectURL(file))
  }

  return (
    <div className="flex flex-wrap items-start gap-4">
      <input type="hidden" name="remove_image" value={removing ? 'true' : 'false'} />

      <div className="flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
        {showing ? (
          /* A blob: URL of the file just picked, or a storage URL. next/image
             would need a remote pattern for one and cannot see the other, and
             a 112px thumbnail is not worth optimising either way. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={showing} alt="" className="h-full w-full object-contain" />
        ) : (
          <span className="text-xs text-slate-400">No image</span>
        )}
      </div>

      <div className="min-w-48 flex-1">
        <input
          id="image"
          name="image"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border file:border-slate-200 file:bg-white file:px-3 file:py-1.5 file:text-xs file:text-slate-700 hover:file:bg-slate-50"
          onChange={(event) => choose(event.target.files?.[0])}
        />

        {problem ? (
          <p className="mt-1 text-xs text-red-600">{problem}</p>
        ) : (
          <p className="mt-1 text-xs text-slate-400">
            JPEG, PNG, WebP, GIF or AVIF, up to {MAX_IMAGE_BYTES / 1024 / 1024} MB. A new one
            replaces the old.
          </p>
        )}

        {currentUrl && !preview && (
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={removing}
              onChange={(event) => setRemoving(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300"
            />
            Remove the current image
          </label>
        )}
      </div>
    </div>
  )
}
