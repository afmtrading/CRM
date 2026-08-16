import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import { contactName, formatDay, formatPrice } from '@/lib/format'
import {
  SIDE_HINTS,
  SIDE_LABELS,
  applyFee,
  directionLabel,
  resolveFee,
  sidesFor,
  type FeeSide,
} from '@/lib/marketplace'
import type {
  CompanyRow,
  ContactRow,
  FieldOptionRow,
  MarketplaceFeeRow,
  MarketplaceProfileRow,
} from '@/lib/database.types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Empty } from '@/components/contact-cards'
import { PageHeader, Section } from '@/components/ui'

import { removeFee, removeMarketplace, setFee, updateMarketplace } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * One channel, and what it costs to use it.
 *
 * The company page answers "who are they". This answers "what do I keep", which
 * is the question that decides where a pallet goes — and the only one the CRM
 * could not answer before.
 */
export default async function MarketplacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const [{ data: company }, { data: profileRow }, { data: feeRows }, { data: contactRows }, { data: options }] =
    await Promise.all([
      scoped(context, 'companies').select('*').eq('id', id).is('deleted_at', null).maybeSingle(),
      scoped(context, 'marketplace_profiles').select('*').eq('company_id', id).maybeSingle(),
      scoped(context, 'marketplace_fees')
        .select('*')
        .eq('marketplace_id', id)
        .order('side')
        .order('category', { nullsFirst: true }),
      scoped(context, 'contacts')
        .select('*')
        .eq('company_id', id)
        .is('deleted_at', null)
        .order('last_name')
        .limit(50),
      scoped(context, 'field_options')
        .select('*')
        .eq('entity_type', 'company')
        .in('field_key', ['marketplace_account_status', 'product_category'])
        .order('order'),
    ])

  // Both have to exist: a company with no profile is not a marketplace, and a
  // profile with no company cannot happen but would be a broken page if it did.
  if (!company || !profileRow) notFound()

  const business = company as CompanyRow
  const profile = profileRow as MarketplaceProfileRow
  const fees = (feeRows ?? []) as MarketplaceFeeRow[]
  const contacts = (contactRows ?? []) as ContactRow[]
  const allOptions = (options ?? []) as FieldOptionRow[]
  const statusOptions = allOptions.filter(
    (option) => option.field_key === 'marketplace_account_status',
  )

  /*
   * The categories a rate can be set for are the organization's product
   * categories, which is what makes the arithmetic real: a product knows its
   * category, so it knows its rate. They live on the product entity, so they
   * are fetched separately from the company options above.
   */
  const { data: categoryRows } = await scoped(context, 'field_options')
    .select('*')
    .eq('entity_type', 'product')
    .eq('field_key', 'product_category')
    .order('order')
  const categories = (categoryRows ?? []) as FieldOptionRow[]

  const currency = profile.payout_currency || context.organization.default_currency
  const sides = sidesFor(profile)

  /*
   * A worked example on a round number, because a percentage is abstract and
   * "you keep $868 of $1,000" is not. The fallback rate, since that is what
   * most things sell at.
   */
  const SAMPLE = 1000
  const example = sides.map((side) => ({
    side,
    breakdown: applyFee(SAMPLE, resolveFee(fees, { side }), side),
  }))

  return (
    <>
      <PageHeader
        title={business.name}
        description={`${directionLabel(profile)} · ${business.based_in ?? 'no country on file'}`}
        actions={
          <>
            <Link href={`/companies/${business.id}`} className="btn-secondary">
              Company record
            </Link>
            {profile.store_url && (
              <a
                href={profile.store_url}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary"
              >
                Open store
              </a>
            )}
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* -------------------------------------------------------------- */}
          <Section title="What it costs">
            {example.length === 0 ? (
              <p className="text-sm text-slate-500">
                This marketplace is not marked as used in either direction.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {example.map(({ side, breakdown }) => (
                  <div key={side} className="rounded-xl border border-slate-200 p-4">
                    <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                      {SIDE_LABELS[side]}
                    </p>

                    {breakdown.totalFees === 0 && fees.every((fee) => fee.side !== side) ? (
                      <p className="mt-2 text-sm text-slate-500">
                        No rates recorded yet, so nothing can be worked out here.
                      </p>
                    ) : (
                      <>
                        <p className="mt-2 text-2xl font-semibold text-slate-900">
                          {formatPrice(breakdown.net, currency)}
                        </p>
                        <p className="text-xs text-slate-500">
                          {side === 'sell'
                            ? `kept from a ${formatPrice(SAMPLE, currency)} sale`
                            : `paid for a ${formatPrice(SAMPLE, currency)} bid`}
                        </p>

                        <dl className="mt-3 space-y-1 text-xs text-slate-600">
                          <Line label="Commission" value={formatPrice(breakdown.commission, currency)} />
                          {breakdown.processing > 0 && (
                            <Line
                              label="Processing"
                              value={formatPrice(breakdown.processing, currency)}
                            />
                          )}
                          {breakdown.fixed > 0 && (
                            <Line label="Fixed" value={formatPrice(breakdown.fixed, currency)} />
                          )}
                          <Line
                            label="Effective rate"
                            value={`${breakdown.effectiveRate}%`}
                            strong
                          />
                        </dl>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            <p className="mt-4 text-xs text-slate-400">
              Worked on {formatPrice(SAMPLE, currency)} at the rate that applies to anything without
              a category of its own. A product in a priced category uses that category&rsquo;s rate
              instead.
            </p>
          </Section>

          {/* -------------------------------------------------------------- */}
          {sides.map((side) => (
            <RateCard
              key={side}
              side={side}
              marketplaceId={id}
              fees={fees.filter((fee) => fee.side === side)}
              categories={categories}
              currency={currency}
              canWrite={context.canWrite}
            />
          ))}

          {/* -------------------------------------------------------------- */}
          <Section title={`Contacts (${contacts.length})`}>
            {contacts.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nobody on file here yet. Add them to{' '}
                <Link href={`/companies/${business.id}`} className="text-brand-700 hover:underline">
                  {business.name}
                </Link>{' '}
                — a marketplace&rsquo;s people are the company&rsquo;s people.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {contacts.map((contact) => (
                  <li key={contact.id} className="flex items-center justify-between gap-3 py-2.5">
                    <Link
                      href={`/contacts/${contact.id}`}
                      className="truncate font-medium text-slate-800 hover:text-brand-700"
                    >
                      {contactName(contact)}
                    </Link>
                    <span className="truncate text-xs text-slate-500">
                      {contact.job_title ?? contact.email ?? ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        {/* ---------------------------------------------------------------- */}
        <div className="space-y-5">
          <Section title="Account">
            <ActionForm action={updateMarketplace} className="space-y-3">
              <input type="hidden" name="company_id" value={id} />

              <fieldset>
                <legend className="label">Used for</legend>
                <label className="flex items-center gap-2 py-0.5 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="sells_through"
                    defaultChecked={profile.sells_through}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Selling
                </label>
                <label className="flex items-center gap-2 py-0.5 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="sources_from"
                    defaultChecked={profile.sources_from}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Sourcing
                </label>
              </fieldset>

              <Field name="store_name" label="Store name" value={profile.store_name} />
              <Field
                name="seller_account_id"
                label="Seller account ID"
                value={profile.seller_account_id}
              />
              <Field
                name="store_url"
                label="Store URL"
                value={profile.store_url}
                placeholder="https://…"
              />

              <div>
                <label className="label" htmlFor="account_status">
                  Account status
                </label>
                <select
                  id="account_status"
                  name="account_status"
                  className="input"
                  defaultValue={profile.account_status ?? ''}
                >
                  <option value="">—</option>
                  {statusOptions.map((option) => (
                    <option key={option.id} value={option.value}>
                      {option.value}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label" htmlFor="opened_on">
                  Opened
                </label>
                <input
                  id="opened_on"
                  name="opened_on"
                  type="date"
                  className="input"
                  defaultValue={profile.opened_on ?? ''}
                />
              </div>

              <Field
                name="settlement_terms"
                label="Payout terms"
                value={profile.settlement_terms}
                placeholder="Weekly, Net 30…"
              />
              <Field name="payout_method" label="Payout method" value={profile.payout_method} />
              <Field
                name="payout_currency"
                label="Settles in"
                value={profile.payout_currency}
                placeholder={context.organization.default_currency}
                maxLength={3}
              />

              <div className="grid grid-cols-2 gap-3">
                <Field
                  name="reserve_percent"
                  label="Reserve %"
                  value={profile.reserve_percent === null ? '' : String(profile.reserve_percent)}
                  type="number"
                />
                <Field
                  name="minimum_lot_value"
                  label="Minimum lot"
                  value={
                    profile.minimum_lot_value === null ? '' : String(profile.minimum_lot_value)
                  }
                  type="number"
                />
              </div>

              <div>
                <label className="label" htmlFor="notes">
                  Notes
                </label>
                <textarea
                  id="notes"
                  name="notes"
                  rows={3}
                  className="input"
                  defaultValue={profile.notes ?? ''}
                />
              </div>

              {context.canWrite && <SubmitButton className="btn-primary w-full">Save</SubmitButton>}
            </ActionForm>
          </Section>

          <Section title="On the company">
            <dl className="space-y-2 text-sm">
              <Row label="Based in">{business.based_in ?? <Empty />}</Row>
              <Row label="Ships to">
                {business.sells_in?.length ? business.sells_in.join(', ') : <Empty />}
              </Row>
              <Row label="Website">
                {business.domain ? (
                  <a
                    href={business.domain.startsWith('http') ? business.domain : `https://${business.domain}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand-700 hover:underline"
                  >
                    {business.domain}
                  </a>
                ) : (
                  <Empty />
                )}
              </Row>
              <Row label="Added">{formatDay(profile.created_at)}</Row>
            </dl>

            {context.canWrite && (
              <form action={removeMarketplace} className="mt-4 border-t border-slate-100 pt-4">
                <input type="hidden" name="company_id" value={id} />
                <button
                  type="submit"
                  className="text-xs text-red-700 hover:underline"
                >
                  Remove from Marketplaces
                </button>
                <p className="mt-1 text-xs text-slate-400">
                  The company, its contacts and its history stay. Only the rate card goes.
                </p>
              </form>
            )}
          </Section>
        </div>
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className={strong ? 'font-medium text-slate-800' : ''}>{value}</dd>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 truncate text-right text-slate-800">{children}</dd>
    </div>
  )
}

function Field({
  name,
  label,
  value,
  placeholder,
  type = 'text',
  maxLength,
}: {
  name: string
  label: string
  value: string | null
  placeholder?: string
  type?: string
  maxLength?: number
}) {
  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        step={type === 'number' ? '0.01' : undefined}
        min={type === 'number' ? '0' : undefined}
        maxLength={maxLength}
        placeholder={placeholder}
        className="input"
        defaultValue={value ?? ''}
      />
    </div>
  )
}

/**
 * The rates for one direction.
 *
 * The fallback row is shown first and labelled as the fallback rather than
 * being left to look like a category called nothing — it is the rate most
 * things trade at, and a rate card whose most-used line reads as blank is one
 * people distrust.
 */
function RateCard({
  side,
  marketplaceId,
  fees,
  categories,
  currency,
  canWrite,
}: {
  side: FeeSide
  marketplaceId: string
  fees: MarketplaceFeeRow[]
  categories: FieldOptionRow[]
  currency: string
  canWrite: boolean
}) {
  const taken = new Set(fees.map((fee) => fee.category).filter(Boolean) as string[])
  const hasFallback = fees.some((fee) => !fee.category)

  return (
    <Section title={SIDE_LABELS[side]}>
      <p className="mb-3 text-xs text-slate-500">{SIDE_HINTS[side]}</p>

      {fees.length === 0 ? (
        <p className="mb-4 text-sm text-slate-500">No rates yet.</p>
      ) : (
        <div className="-mx-5 mb-4 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Category</th>
                <th className="text-right">Commission</th>
                <th className="text-right">Processing</th>
                <th className="text-right">Fixed</th>
                <th>Note</th>
                {canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {fees.map((fee) => (
                <tr key={fee.id}>
                  <td className="font-medium text-slate-800">
                    {fee.category ?? (
                      <span className="text-slate-500">Everything else</span>
                    )}
                  </td>
                  <td className="text-right">{Number(fee.percent)}%</td>
                  <td className="text-right text-slate-600">
                    {Number(fee.processing_percent) > 0 ? `${Number(fee.processing_percent)}%` : '—'}
                  </td>
                  <td className="text-right text-slate-600">
                    {Number(fee.fixed_fee) > 0 ? formatPrice(Number(fee.fixed_fee), currency) : '—'}
                  </td>
                  <td className="text-xs text-slate-500">{fee.note ?? ''}</td>
                  {canWrite && (
                    <td className="text-right">
                      <form action={removeFee}>
                        <input type="hidden" name="fee_id" value={fee.id} />
                        <input type="hidden" name="marketplace_id" value={marketplaceId} />
                        <button
                          type="submit"
                          className="text-xs text-slate-400 hover:text-red-600"
                          aria-label={`Remove the ${fee.category ?? 'fallback'} rate`}
                        >
                          ✕
                        </button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && (
        <ActionForm action={setFee} className="grid gap-2 sm:grid-cols-[1.4fr_repeat(3,5.5rem)_auto]">
          <input type="hidden" name="marketplace_id" value={marketplaceId} />
          <input type="hidden" name="side" value={side} />

          <select name="category" className="input" aria-label="Category for this rate">
            <option value="">
              {hasFallback ? 'Everything else (replaces)' : 'Everything else'}
            </option>
            {categories.map((category) => (
              <option key={category.id} value={category.value}>
                {category.value}
                {taken.has(category.value) ? ' (replaces)' : ''}
              </option>
            ))}
          </select>

          <input
            name="percent"
            type="number"
            step="0.001"
            min="0"
            max="100"
            className="input"
            placeholder="%"
            aria-label="Commission percent"
          />
          <input
            name="processing_percent"
            type="number"
            step="0.001"
            min="0"
            max="100"
            className="input"
            placeholder="Proc %"
            aria-label="Processing percent"
          />
          <input
            name="fixed_fee"
            type="number"
            step="0.01"
            min="0"
            className="input"
            placeholder="Fixed"
            aria-label="Fixed fee"
          />

          <SubmitButton className="btn-secondary">Set rate</SubmitButton>
        </ActionForm>
      )}
    </Section>
  )
}
