'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import type { OrganizationRow } from '@/lib/database.types'

import { setOrganizationLogoUrl, uploadOrganizationLogo } from '../actions'

/**
 * The logo, in its own two forms.
 *
 * Outside the organization form rather than in it, and not by preference: a
 * form cannot be nested in another, and this needs two of them — one posting a
 * file, one posting a URL. Both write the same column, so an upload and a
 * pasted address are two ways of answering one question rather than two
 * settings that can disagree.
 */
export function LogoField({ organization }: { organization: OrganizationRow }) {
  const logo = organization.logo_url

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-32 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50">
          {logo ? (
            /*
              A plain img, not next/image: the source is whatever an
              administrator pasted, and the optimizer refuses hosts that are
              not in its allow-list — which would turn a working logo into a
              broken one for no gain on an image this size.
            */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt={`${organization.name} logo`}
              className="max-h-16 max-w-28 object-contain"
            />
          ) : (
            <span className="text-xs text-slate-400">No logo</span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <ActionForm action={uploadOrganizationLogo} className="space-y-2">
            <label className="label" htmlFor="org-logo-file">
              Upload an image
            </label>
            <input
              id="org-logo-file"
              name="logo"
              type="file"
              accept="image/png,image/jpeg"
              className="input py-1.5 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1 file:text-xs file:font-medium file:text-white"
            />
            <SubmitButton className="btn-secondary" pendingLabel="Uploading…">
              Upload logo
            </SubmitButton>
            <p className="text-xs text-slate-400">
              PNG or JPEG, up to 2 MB. Not SVG — the document renderer draws nothing for one,
              which you would only notice on a printed order.
            </p>
          </ActionForm>
        </div>
      </div>

      <ActionForm action={setOrganizationLogoUrl} className="border-t border-slate-100 pt-4">
        <label className="label" htmlFor="org-logo-url">
          Or point at one already hosted
        </label>
        <div className="flex gap-2">
          <input
            id="org-logo-url"
            name="logo_url"
            className="input"
            placeholder="https://…"
            defaultValue={logo ?? ''}
          />
          <SubmitButton className="btn-secondary shrink-0" pendingLabel="Saving…">
            Save
          </SubmitButton>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Clearing this and saving removes the logo. An image uploaded here is deleted with it;
          one hosted elsewhere is only unlinked.
        </p>
      </ActionForm>
    </div>
  )
}
