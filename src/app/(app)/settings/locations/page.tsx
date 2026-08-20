import { requireSession, scoped } from '@/lib/tenancy'
import type { StockBinRow, StockLocationRow } from '@/lib/database.types'
import { formatQuantity } from '@/lib/stock'
import { PageHeader, Section } from '@/components/ui'
import { ActionForm, SubmitButton } from '@/components/action-form'

import {
  createStockBin,
  createStockLocation,
  deleteStockBin,
  setStockLocationActive,
} from '../actions'

export const metadata = { title: 'Locations · FLO CRM' }

type LocationWithCount = StockLocationRow & { stock_levels: { count: number }[] }

export default async function LocationsPage() {
  const context = await requireSession()

  const [{ data: locations }, { data: bins }] = await Promise.all([
    scoped(context, 'stock_locations').select('*, stock_levels(count)').order('name'),
    scoped(context, 'stock_bins').select('*').order('name'),
  ])

  const locationList = (locations ?? []) as LocationWithCount[]
  const binList = (bins ?? []) as StockBinRow[]

  return (
    <>
      <PageHeader title="Locations" />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Section title={`${locationList.length} location${locationList.length === 1 ? '' : 's'}`}>
            {locationList.length === 0 ? (
              <p className="text-sm text-slate-500">
                No locations yet. Add one before counting anything.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {locationList.map((location) => {
                  const here = binList.filter((bin) => bin.location_id === location.id)
                  const lines = location.stock_levels?.[0]?.count ?? 0

                  return (
                    <li key={location.id} className="py-4 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-900">
                            {location.name}
                            {location.code && (
                              <span className="ml-2 text-xs text-slate-400">{location.code}</span>
                            )}
                            {!location.active && (
                              <span className="badge ml-2 bg-slate-100 text-slate-500">retired</span>
                            )}
                          </p>
                          {location.address && (
                            <p className="text-xs text-slate-500">{location.address}</p>
                          )}
                          <p className="mt-0.5 text-xs text-slate-400">
                            {formatQuantity(lines)} product{lines === 1 ? '' : 's'} counted here
                          </p>
                        </div>

                        {context.canManage && (
                          <form action={setStockLocationActive}>
                            <input type="hidden" name="id" value={location.id} />
                            <input
                              type="hidden"
                              name="active"
                              value={location.active ? 'false' : 'true'}
                            />
                            <button
                              type="submit"
                              className="text-xs text-slate-400 hover:text-brand-700"
                            >
                              {location.active ? 'Retire' : 'Bring back'}
                            </button>
                          </form>
                        )}
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {here.map((bin) => (
                          <span
                            key={bin.id}
                            className="badge flex items-center gap-1 bg-slate-100 text-slate-700"
                          >
                            {bin.name}
                            {context.canManage && (
                              <form action={deleteStockBin} className="contents">
                                <input type="hidden" name="id" value={bin.id} />
                                <button
                                  type="submit"
                                  className="text-slate-400 hover:text-red-600"
                                  aria-label={`Delete bin ${bin.name}`}
                                >
                                  ✕
                                </button>
                              </form>
                            )}
                          </span>
                        ))}

                        {context.canManage && (
                          <ActionForm action={createStockBin} className="flex items-center gap-2">
                            <input type="hidden" name="location_id" value={location.id} />
                            <input
                              name="name"
                              className="input h-8 w-32 py-1 text-xs"
                              placeholder="Add a bin…"
                              aria-label={`New bin in ${location.name}`}
                            />
                            <SubmitButton
                              className="text-xs text-brand-700 hover:underline"
                              pendingLabel="Adding…"
                            >
                              Add
                            </SubmitButton>
                          </ActionForm>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            <p className="mt-4 text-xs text-slate-400">
              A location is retired rather than deleted, so the record of what was counted in it
              survives. Deleting a bin leaves its stock in the location it stood in.
            </p>
          </Section>
        </div>

        {context.canManage && (
          <Section title="Add a location">
            <ActionForm action={createStockLocation} className="space-y-3">
              <div>
                <label className="label" htmlFor="location-name">
                  Name
                </label>
                <input
                  id="location-name"
                  name="name"
                  required
                  className="input"
                  placeholder="Toronto Warehouse"
                />
              </div>

              <div>
                <label className="label" htmlFor="location-code">
                  Code
                </label>
                <input id="location-code" name="code" className="input" placeholder="TOR" />
                <p className="mt-1 text-xs text-slate-400">
                  Optional. A short label for tables and pickers.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="location-address">
                  Address
                </label>
                <textarea
                  id="location-address"
                  name="address"
                  rows={2}
                  className="input"
                  placeholder="Street, city, postal code"
                />
              </div>

              <SubmitButton className="btn-primary" pendingLabel="Adding…">
                Add location
              </SubmitButton>
            </ActionForm>
          </Section>
        )}
      </div>
    </>
  )
}
