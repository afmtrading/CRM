import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import { contactName, formatDay, formatPrice } from '@/lib/format'
import { renderMarkdown } from '@/lib/field-options'
import { MARKETPLACE_OPTION_FIELDS, directionLabel, yesNo } from '@/lib/marketplace'
import type {
  CompanyRow,
  ContactRow,
  FieldOptionRow,
  MarketplaceProfileRow,
} from '@/lib/database.types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Empty, OptionBadge, OptionBadges, optionColor } from '@/components/contact-cards'
import { PageHeader, Section } from '@/components/ui'

import { removeMarketplace, updateMarketplace } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * One channel, and what tells it apart from the next one.
 *
 * A per-category rate card lived here and was taken out. What it cost to keep
 * true was a row per category per direction; what it answered was "is this
 * expensive", which one field says. So the percentages are prose now and the
 * comparison is a select — and the page is a page somebody will actually fill
 * in rather than one they will abandon half-priced.
 */
export default async function MarketplacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const [
    { data: company },
    { data: profileRow },
    { data: contactRows },
    { data: options },
    { data: salesRows },
  ] = await Promise.all([
      scoped(context, 'companies').select('*').eq('id', id).is('deleted_at', null).maybeSingle(),
      scoped(context, 'marketplace_profiles').select('*').eq('company_id', id).maybeSingle(),
      scoped(context, 'contacts')
        .select('*')
        .eq('company_id', id)
        .is('deleted_at', null)
        .order('last_name')
        .limit(50),
      /*
       * All on the company entity, priority included since 20260247000000 —
       * a marketplace is a company, and it reads the company's priority rather
       * than carrying one of its own.
       */
      scoped(context, 'field_options')
        .select('*')
        .eq('entity_type', 'company')
        .order('order'),
      /*
       * What has actually gone through this channel. Definer and
       * organization-scoped, not caller-scoped: orders are visible per owner,
       * so reading them here through the caller's policies would tell a rep
       * their channel had turned over a fraction of what it had.
       */
      context.supabase.rpc('marketplace_sales', { p_marketplace_id: id }),
    ])

  // Both have to exist: a company with no profile is not a marketplace, and a
  // profile with no company cannot happen but would be a broken page if it did.
  if (!company || !profileRow) notFound()

  const business = company as CompanyRow
  const profile = profileRow as MarketplaceProfileRow
  const contacts = (contactRows ?? []) as ContactRow[]
  const allOptions = (options ?? []) as FieldOptionRow[]
  const optionsFor = (key: string) => allOptions.filter((option) => option.field_key === key)

  const sales = (salesRows ?? []) as {
    currency: string
    order_count: number
    order_value: number
    invoice_count: number
    invoiced: number
    collected: number
  }[]

  const currency = profile.payout_currency || context.organization.default_currency
  const feesHtml = renderMarkdown(profile.fee_notes)
  const premium = yesNo(profile.buyers_premium)

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
              <a href={profile.store_url} target="_blank" rel="noreferrer" className="btn-secondary">
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
            {feesHtml ? (
              // Safe by construction: renderMarkdown escapes the stored text
              // before applying any formatting, so nothing here is raw HTML.
              <div
                className="space-y-2 text-sm leading-relaxed text-slate-700"
                dangerouslySetInnerHTML={{ __html: feesHtml }}
              />
            ) : (
              <p className="text-sm text-slate-500">
                Nothing recorded yet. Commission, listing fees, processing, whatever this platform
                charges — in whatever words fit.
              </p>
            )}

            {profile.selling_cost && (
              <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-4">
                <span className="text-xs text-slate-500">Selling cost</span>
                <OptionBadge
                  value={profile.selling_cost}
                  color={optionColor(
                    optionsFor(MARKETPLACE_OPTION_FIELDS.sellingCost),
                    profile.selling_cost,
                  )}
                />
              </div>
            )}
          </Section>

          {/* -------------------------------------------------------------- */}
          <Section title="How it works">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Fact label="Marketplace type">
                <OptionBadges
                  values={profile.marketplace_type}
                  options={optionsFor(MARKETPLACE_OPTION_FIELDS.type)}
                />
              </Fact>
              <Fact label="Fulfilment">
                <OptionBadges
                  values={profile.fulfilment}
                  options={optionsFor(MARKETPLACE_OPTION_FIELDS.fulfilment)}
                />
              </Fact>
              <Fact label="Payment">
                {profile.payment ? (
                  <OptionBadge
                    value={profile.payment}
                    color={optionColor(
                      optionsFor(MARKETPLACE_OPTION_FIELDS.payment),
                      profile.payment,
                    )}
                  />
                ) : (
                  <Empty />
                )}
              </Fact>
              <Fact label="Buyer's premium">
                {/* Three states: yes, no, and nobody has said. */}
                {premium ?? <span className="text-xs text-slate-400">Not recorded</span>}
              </Fact>
              <Fact label="Audience">
                <OptionBadges
                  values={profile.audience}
                  options={optionsFor(MARKETPLACE_OPTION_FIELDS.audience)}
                />
              </Fact>
              <Fact label="Inventory type">
                <OptionBadges
                  values={profile.inventory_type}
                  options={optionsFor(MARKETPLACE_OPTION_FIELDS.inventoryType)}
                />
              </Fact>
              {/* The company's, like Sells in below it — a marketplace has no
                  priority of its own to disagree with the account's. */}
              <Fact label="Priority" hint="From the company record">
                {business.priority ? (
                  <OptionBadge
                    value={business.priority}
                    color={optionColor(
                      optionsFor(MARKETPLACE_OPTION_FIELDS.priority),
                      business.priority,
                    )}
                  />
                ) : (
                  <Link
                    href={`/companies/${business.id}/edit`}
                    className="text-xs text-brand-700 hover:underline"
                  >
                    Set on the company
                  </Link>
                )}
              </Fact>
              {/*
                The company's, not a copy. companies.sells_in already normalises
                to sorted ISO codes and is what the territory filters read; a
                second copy here would be a second thing to keep true.
              */}
              <Fact label="Sells in" hint="From the company record">
                {business.sells_in?.length ? (
                  <span className="text-slate-700">{business.sells_in.join(', ')}</span>
                ) : (
                  <Link
                    href={`/companies/${business.id}/edit`}
                    className="text-xs text-brand-700 hover:underline"
                  >
                    Set on the company
                  </Link>
                )}
              </Fact>
            </dl>
          </Section>

          {/* -------------------------------------------------------------- */}
          <Section title="Sold through this channel">
            {sales.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nothing attributed to this channel yet. A sales order says which channel it sold
                through, and its invoice carries that across.
              </p>
            ) : (
              <div className="-mx-5 overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Currency</th>
                      <th className="text-right">Orders</th>
                      <th className="text-right">Order value</th>
                      <th className="text-right">Invoiced</th>
                      <th className="text-right">Collected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/*
                      One row per currency rather than one total. Adding USD to
                      CAD produces a number that means nothing, which is the
                      rule the money components already hold.
                    */}
                    {sales.map((row) => (
                      <tr key={row.currency}>
                        <td className="font-medium text-slate-800">{row.currency}</td>
                        <td className="text-right text-slate-600">{row.order_count}</td>
                        <td className="text-right">
                          {formatPrice(Number(row.order_value), row.currency)}
                        </td>
                        <td className="text-right">
                          {formatPrice(Number(row.invoiced), row.currency)}
                        </td>
                        <td className="text-right font-medium text-slate-900">
                          {formatPrice(Number(row.collected), row.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-slate-400">
              Cancelled orders and void invoices are left out — they are not money anybody expects.
              Set against the fees above, this is what the channel actually returned.
            </p>
          </Section>

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
          <Section title="Details">
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

              <Multi
                name="marketplace_type"
                label="Marketplace type"
                options={optionsFor(MARKETPLACE_OPTION_FIELDS.type)}
                selected={profile.marketplace_type}
              />
              <Single
                name="selling_cost"
                label="Selling cost"
                options={optionsFor(MARKETPLACE_OPTION_FIELDS.sellingCost)}
                selected={profile.selling_cost}
              />
              <Multi
                name="fulfilment"
                label="Fulfilment"
                options={optionsFor(MARKETPLACE_OPTION_FIELDS.fulfilment)}
                selected={profile.fulfilment}
              />
              <Single
                name="payment"
                label="Payment"
                options={optionsFor(MARKETPLACE_OPTION_FIELDS.payment)}
                selected={profile.payment}
              />

              <div>
                <label className="label" htmlFor="buyers_premium">
                  Buyer&rsquo;s premium
                </label>
                <select
                  id="buyers_premium"
                  name="buyers_premium"
                  className="input"
                  defaultValue={
                    profile.buyers_premium === null ? '' : String(profile.buyers_premium)
                  }
                >
                  {/* Blank is a real answer, not a prompt: it means nobody has
                      looked it up, which is different from there being none. */}
                  <option value="">Not recorded</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>

              <Multi
                name="audience"
                label="Audience"
                options={optionsFor(MARKETPLACE_OPTION_FIELDS.audience)}
                selected={profile.audience}
              />
              <Multi
                name="inventory_type"
                label="Inventory type"
                options={optionsFor(MARKETPLACE_OPTION_FIELDS.inventoryType)}
                selected={profile.inventory_type}
              />
              <div>
                <label className="label" htmlFor="fee_notes">
                  Fees and costs
                </label>
                <textarea
                  id="fee_notes"
                  name="fee_notes"
                  rows={6}
                  maxLength={20000}
                  className="input font-normal"
                  defaultValue={profile.fee_notes ?? ''}
                  placeholder={'15% seller fee\n3% processing\n$0.30 a listing, waived under $50'}
                />
                <p className="mt-1 text-xs text-slate-400">
                  Markdown: **bold**, `-` bullets, [links](url).
                </p>
              </div>

              <details className="border-t border-slate-100 pt-3">
                <summary className="cursor-pointer text-xs font-medium text-slate-500">
                  Account and payouts
                </summary>

                <div className="mt-3 space-y-3">
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
                  <Single
                    name="account_status"
                    label="Account status"
                    options={optionsFor(MARKETPLACE_OPTION_FIELDS.accountStatus)}
                    selected={profile.account_status}
                  />
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
                </div>
              </details>

              {context.canWrite && <SubmitButton className="btn-primary w-full">Save</SubmitButton>}
            </ActionForm>
          </Section>

          <Section title="On the company">
            <dl className="space-y-2 text-sm">
              <Row label="Based in">{business.based_in ?? <Empty />}</Row>
              <Row label="Minimum lot">
                {profile.minimum_lot_value === null ? (
                  <Empty />
                ) : (
                  formatPrice(Number(profile.minimum_lot_value), currency)
                )}
              </Row>
              <Row label="Website">
                {business.domain ? (
                  <a
                    href={
                      business.domain.startsWith('http')
                        ? business.domain
                        : `https://${business.domain}`
                    }
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
                <button type="submit" className="text-xs text-red-700 hover:underline">
                  Remove from Marketplaces
                </button>
                <p className="mt-1 text-xs text-slate-400">
                  The company, its contacts and its history stay. Only this profile goes.
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

function Fact({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <dt className="text-xs text-slate-500">
        {label}
        {hint && <span className="ml-1 text-slate-400">· {hint}</span>}
      </dt>
      <dd className="mt-1 text-sm text-slate-800">{children}</dd>
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

function Single({
  name,
  label,
  options,
  selected,
}: {
  name: string
  label: string
  options: FieldOptionRow[]
  selected: string | null
}) {
  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
      </label>
      <select id={name} name={name} className="input" defaultValue={selected ?? ''}>
        <option value="">—</option>
        {options.map((option) => (
          <option key={option.id} value={option.value}>
            {option.value}
          </option>
        ))}
      </select>
      {options.length === 0 && <MissingList />}
    </div>
  )
}

/**
 * A multi-select as checkboxes rather than a `<select multiple>`.
 *
 * These lists hold two or three values each. A multiple select would make
 * somebody hold ⌘ to pick both of two, and would hide the second option behind
 * a scroll on a narrow screen; two checkboxes are the whole list, visible.
 */
function Multi({
  name,
  label,
  options,
  selected,
}: {
  name: string
  label: string
  options: FieldOptionRow[]
  selected: string[]
}) {
  const chosen = new Set(selected)

  return (
    <fieldset>
      <legend className="label">{label}</legend>
      {options.map((option) => (
        <label
          key={option.id}
          className="flex items-center gap-2 py-0.5 text-sm text-slate-700"
        >
          <input
            type="checkbox"
            name={name}
            value={option.value}
            defaultChecked={chosen.has(option.value)}
            className="h-4 w-4 rounded border-slate-300"
          />
          {option.value}
        </label>
      ))}
      {options.length === 0 && <MissingList />}
    </fieldset>
  )
}

function MissingList() {
  return (
    <p className="mt-1 text-xs text-amber-700">
      Nothing to choose from —{' '}
      <Link href="/settings/fields" className="underline">
        add values in Settings → Fields
      </Link>
      .
    </p>
  )
}
