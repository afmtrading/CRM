import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import { placeNames, type Place } from '@/lib/geography'
import { renderMarkdown, COMPANY_CARDS, optionsForField } from '@/lib/field-options'
import { MARKETPLACE_OPTION_FIELDS } from '@/lib/marketplace'
import type {
  ActivityRow,
  CompanyRow,
  ContactCard,
  ContactRow,
  CustomFieldDefinitionRow,
  FieldOptionRow,
  MarketplaceProfileRow,
  TagRow,
  UserRow,
} from '@/lib/database.types'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { ActivityComposer, ActivityTimeline } from '@/components/activity-timeline'
import { CompanyRatingRows } from '@/components/company-rating'
import {
  CompanyAdditionalRows,
  CompanyContactsTable,
  CompanyDealsTable,
  CompanyDigitalRows,
  CompanyInfoRows,
  type CompanyDeal,
} from '@/components/company-cards'
import { PageHeader, Section } from '@/components/ui'
import { TagPicker } from '@/components/tag-picker'

import { removeMarketplace, updateMarketplace } from '../actions'
import { setCompanyTags } from '../../companies/actions'

export const dynamic = 'force-dynamic'

/**
 * One channel, and what tells it apart from the next one.
 *
 * The page is the company record with the channel's own answers in front of
 * it, which is what a marketplace is: not a second kind of record, but a
 * company you also sell through. So the left column is what only a marketplace
 * has — what it is, what it costs, the account behind it — and the right is
 * the company itself, rendered by the very components the company's own page
 * renders (see components/company-cards). Neither side can drift from the
 * other, because there is only one of each.
 *
 * The channel's own fields are edited here rather than on a separate form
 * page, one card at a time. Each card is its own form and names itself, so
 * saving one leaves the other two alone — see marketplaceSections for why that
 * has to be said out loud rather than inferred.
 */
export default async function MarketplacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const [
    { data: company },
    { data: profileRow },
    { data: contactRows },
    { data: dealRows },
    { data: activities },
    { data: users },
    { data: options },
    { data: customFieldDefs },
    { data: tags },
    { data: companyTags },
    { data: countryRows },
  ] = await Promise.all([
    scoped(context, 'companies').select('*').eq('id', id).is('deleted_at', null).maybeSingle(),
    scoped(context, 'marketplace_profiles').select('*').eq('company_id', id).maybeSingle(),
    /*
     * The same query the company's own page runs, because it feeds the same
     * table: survivors only, in name order.
     */
    scoped(context, 'contacts')
      .select('*')
      .eq('company_id', id)
      .is('duplicate_of_id', null)
      .is('deleted_at', null)
      .order('last_name'),
    scoped(context, 'deals')
      .select('*, stages(name), contacts(id, first_name, last_name)')
      .eq('company_id', id)
      .order('created_at', { ascending: false }),
    /*
     * Logged against the company, not the profile — a call with an
     * auctioneer is a call with the business, and it should read the same on
     * whichever of its two pages you opened.
     */
    scoped(context, 'activities')
      .select('*')
      .eq('related_to_type', 'company')
      .eq('related_to_id', id)
      .order('occurred_at', { ascending: false })
      .limit(100),
    scoped(context, 'users').select('*').order('name'),
    /*
     * Every entity's options, not just the company's: the contacts table below
     * draws priority, role type and credibility, and those are the contact's
     * lists. Picked apart by entity at the point of use — matching on the key
     * alone is how a badge ends up wearing another record type's colour.
     */
    scoped(context, 'field_options').select('*').order('order'),
    scoped(context, 'custom_field_definitions')
      .select('*')
      .eq('entity_type', 'company')
      .order('order'),
    /*
     * The company's tags, for the same reason as its priority: a marketplace
     * is a company. Editing them here rather than only on the company page,
     * which is where they had to be set from until now.
     */
    scoped(context, 'tags').select('*').order('name'),
    scoped(context, 'company_tags').select('tag_id').eq('company_id', id),
    /*
     * Reference data, not tenant data, which is why it is not scoped. The
     * company's base country and territories are codes, and every screen
     * that shows one spells it out.
     */
    context.supabase.from('countries').select('code, name, kind').order('sort_order').order('name'),
  ])

  // Both have to exist: a company with no profile is not a marketplace, and a
  // profile with no company cannot happen but would be a broken page if it did.
  if (!company || !profileRow) notFound()

  const business = company as CompanyRow
  const profile = profileRow as MarketplaceProfileRow
  const contacts = (contactRows ?? []) as ContactRow[]
  const deals = (dealRows ?? []) as CompanyDeal[]
  const userList = (users ?? []) as UserRow[]
  const tagList = (tags ?? []) as TagRow[]
  const selectedTagIds = new Set(((companyTags ?? []) as { tag_id: string }[]).map((t) => t.tag_id))

  const allOptions = (options ?? []) as FieldOptionRow[]
  const optionsFor = (key: string) => optionsForField(allOptions, 'company', key)

  const customFields = (customFieldDefs ?? []) as CustomFieldDefinitionRow[]
  const customByCard = (card: ContactCard) => customFields.filter((field) => field.card === card)

  const places = placeNames((countryRows ?? []) as Place[])

  const userName = (userId: string | null) => {
    if (!userId) return null
    const user = userList.find((candidate) => candidate.id === userId)
    return user ? user.name || user.email : null
  }

  const feesHtml = renderMarkdown(profile.fee_notes)

  return (
    <>
      <PageHeader
        title={business.name}
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
        {/* ---------------------------------------------------------------- */}
        {/* What only a marketplace has                                      */}
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-5 lg:col-span-2">
          <Section title="Marketplace detail">
            {/*
              What the channel is, in one card. It used to be two — a read-only
              "How it works" beside a form that set the same eight fields — and
              a record that states a value twice is a record that can be caught
              disagreeing with itself.
            */}
            <ActionForm action={updateMarketplace} className="space-y-3">
              <input type="hidden" name="company_id" value={id} />
              <input type="hidden" name="section" value="detail" />

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

              <div className="grid gap-3 sm:grid-cols-2">
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
              </div>

              {context.canWrite && <SubmitButton className="btn-primary">Save</SubmitButton>}
            </ActionForm>
          </Section>

          {/* -------------------------------------------------------------- */}
          <Section title="Fees, costs and notes">
            {/*
              What it charges, written rather than tabulated. A per-category
              rate card lived here and was taken out: keeping it true meant a
              row per category per direction, and the decision it existed to
              support — is this channel expensive — needs three values, not
              three decimal places. So the percentages are prose and the
              comparison is the Selling cost field on the card above.
            */}
            {feesHtml && (
              <div
                // Safe by construction: renderMarkdown escapes the stored text
                // before applying any formatting, so nothing here is raw HTML.
                className="mb-4 space-y-2 border-b border-slate-100 pb-4 text-sm leading-relaxed text-slate-700"
                dangerouslySetInnerHTML={{ __html: feesHtml }}
              />
            )}

            <ActionForm action={updateMarketplace} className="space-y-3">
              <input type="hidden" name="company_id" value={id} />
              <input type="hidden" name="section" value="fees" />

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
                  Markdown: **bold**, `-` bullets, [links](url). Commission, listing fees,
                  processing — whatever this platform charges, in whatever words fit.
                </p>
              </div>

              {context.canWrite && <SubmitButton className="btn-primary">Save</SubmitButton>}
            </ActionForm>
          </Section>

          {/* -------------------------------------------------------------- */}
          <Section title="Accounts and payouts">
            {/*
              Everything about the account itself, which used to be folded away
              behind a disclosure inside another card. It is the half of a
              channel somebody has to go and look up, so it is worth a card
              rather than a fold.
            */}
            <ActionForm action={updateMarketplace} className="space-y-3">
              <input type="hidden" name="company_id" value={id} />
              <input type="hidden" name="section" value="account" />

              <div className="grid gap-3 sm:grid-cols-2">
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

              {context.canWrite && <SubmitButton className="btn-primary">Save</SubmitButton>}
            </ActionForm>

            {/*
              Demoting the channel lives at the foot of the most administrative
              card rather than up in the header beside "Open store". It is the
              one destructive thing on the page and it needs its sentence more
              than it needs prominence.
            */}
            {context.canWrite && (
              <form action={removeMarketplace} className="mt-5 border-t border-slate-100 pt-4">
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

          {/* -------------------------------------------------------------- */}
          <Section
            title="Contacts"
            actions={
              context.canWrite && (
                <Link href={`/contacts/new?company_id=${id}`} className="btn-secondary py-1">
                  New contact
                </Link>
              )
            }
          >
            <CompanyContactsTable
              contacts={contacts}
              options={allOptions}
              emptyMessage={
                <>
                  Nobody on file here yet &mdash; a marketplace&rsquo;s people are the
                  company&rsquo;s people.
                </>
              }
            />
          </Section>

          <Section
            title="Deals"
            actions={
              context.canWrite && (
                <Link href={`/deals/new?company_id=${id}`} className="btn-secondary py-1">
                  New deal
                </Link>
              )
            }
          >
            <CompanyDealsTable deals={deals} userName={userName} />
          </Section>

          <Section title="Activity">
            <ActivityComposer
              relatedToType="company"
              relatedToId={id}
              users={userList}
              currentUserId={context.user.id}
            />
            <div className="mt-4 border-t border-slate-100 pt-2">
              <ActivityTimeline
                activities={(activities ?? []) as ActivityRow[]}
                users={userList}
                returnTo={`/marketplaces/${id}`}
                emptyMessage="Nothing logged against this company yet."
              />
            </div>
          </Section>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* The company underneath, exactly as its own page tells it          */}
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-5">
          <Section
            title={COMPANY_CARDS[0].label}
            actions={
              <p className="min-w-0 truncate text-sm text-slate-500">
                Owner:{' '}
                <span className="font-semibold text-slate-900">
                  {userName(business.owner_id) ?? '—'}
                </span>
              </p>
            }
          >
            <dl className="divide-y divide-slate-100">
              <CompanyInfoRows
                company={business}
                options={allOptions}
                customFields={customByCard('details')}
                contactCount={contacts.length}
              />
            </dl>
          </Section>

          <Section title={COMPANY_CARDS[3].label}>
            <dl className="divide-y divide-slate-100">
              <CompanyRatingRows
                company={business}
                options={allOptions}
                customFields={customByCard('rating')}
                placeName={places.country}
              />
            </dl>
          </Section>

          <Section title={COMPANY_CARDS[2].label}>
            <dl className="divide-y divide-slate-100">
              <CompanyDigitalRows
                company={business}
                options={allOptions}
                customFields={customByCard('digital')}
              />
            </dl>
          </Section>

          <Section title="Tags">
            <form action={setCompanyTags} className="space-y-3">
              <input type="hidden" name="company_id" value={id} />
              <TagPicker
                tags={tagList}
                selected={selectedTagIds}
                canManage={context.isAdmin}
                canCreate={context.canWrite}
                autoSubmit
              />
            </form>
          </Section>

          <Section title={COMPANY_CARDS[1].label}>
            <dl className="divide-y divide-slate-100">
              <CompanyAdditionalRows
                company={business}
                options={allOptions}
                customFields={customByCard('additional')}
              />
            </dl>
          </Section>
        </div>
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */

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
        <label key={option.id} className="flex items-center gap-2 py-0.5 text-sm text-slate-700">
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
