import type { OrganizationRow } from '@/lib/database.types'
import { TIMEZONES, timeZoneAbbreviation, timeZoneLabel } from '@/lib/timezone'

import { CURRENCIES } from '@/lib/format'

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
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400">
          What a new deal, product, order or invoice is priced in. Changing it never restates
          anything already raised — those keep the currency they were entered in.
        </p>
      </div>

      {/*
        One clock for the whole organization, not the reader's.
        A report is a statement about the business: two people reading the same
        figure from different cities have to see the same number, and a deal
        raised at 8pm belongs to the day it was raised on here.
      */}
      <div>
        <label className="label" htmlFor="org-timezone">
          Time zone
        </label>
        <select
          id="org-timezone"
          name="timezone"
          className="input"
          defaultValue={organization.timezone}
        >
          {TIMEZONES.map((zone) => (
            <option key={zone.value} value={zone.value}>
              {zone.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400">
          Every date on every report is read against this clock — currently{' '}
          {timeZoneLabel(organization.timezone)} ({timeZoneAbbreviation(organization.timezone)}).
        </p>
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
