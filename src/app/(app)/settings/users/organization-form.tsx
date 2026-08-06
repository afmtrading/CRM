import type { OrganizationRow } from '@/lib/database.types'

import { updateOrganization } from '../actions'

export function OrganizationForm({ organization }: { organization: OrganizationRow }) {
  return (
    <form action={updateOrganization} className="grid gap-4 sm:grid-cols-2">
      <div>
        <label className="label" htmlFor="org-name">
          Name
        </label>
        <input id="org-name" name="name" className="input" defaultValue={organization.name} />
      </div>

      <div>
        <label className="label" htmlFor="org-currency">
          Default currency
        </label>
        <select
          id="org-currency"
          name="default_currency"
          className="input"
          defaultValue={organization.default_currency}
        >
          <option value="CAD">CAD</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="GBP">GBP</option>
        </select>
      </div>

      <div>
        <label className="label" htmlFor="org-color">
          Primary colour
        </label>
        <input
          id="org-color"
          name="primary_color"
          type="color"
          className="input h-9 py-1"
          defaultValue={organization.primary_color}
        />
      </div>

      <div>
        <label className="label" htmlFor="org-logo">
          Logo URL
        </label>
        <input
          id="org-logo"
          name="logo_url"
          className="input"
          placeholder="https://…"
          defaultValue={organization.logo_url ?? ''}
        />
      </div>

      <div className="sm:col-span-2">
        <button type="submit" className="btn-primary">
          Save organization
        </button>
        <p className="mt-2 text-xs text-slate-400">
          Slug: <code className="rounded bg-slate-100 px-1">{organization.slug}</code> · created{' '}
          {new Date(organization.created_at).toLocaleDateString('en-CA')}
        </p>
      </div>
    </form>
  )
}
