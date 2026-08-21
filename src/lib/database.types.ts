/**
 * Row shapes for every table in supabase/migrations.
 *
 * These are hand-maintained and used to type query results at the call site
 * (`.maybeSingle<ContactRow>()`, `as ContactRow[]`). The Supabase client itself
 * is deliberately left untyped: a hand-written Database generic cannot describe
 * foreign-key relationships accurately enough for nested selects like
 * `select('*, companies(id, name)')` to resolve, and a wrong generic is worse
 * than none.
 *
 * Once the Supabase project exists, generate the real thing:
 *
 *   supabase gen types typescript --project-id <id> > src/lib/database.generated.ts
 *
 * then pass it to createServerClient/createBrowserClient as the generic and
 * drop the casts. The Database type below is kept in the generator's shape so
 * that swap is mechanical.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type OrgStatus = 'active' | 'inactive'
export type UserRole = 'admin' | 'manager' | 'sales_director' | 'regular' | 'readonly'
export type UserStatus = 'active' | 'invited' | 'disabled'
export type LifecycleStage = 'lead' | 'qualified' | 'customer' | 'other'
export type DealStatus = 'open' | 'won' | 'lost'
export type DealValueSource = 'manual' | 'products'
export type SalesOrderStatus = 'draft' | 'reserved' | 'confirmed' | 'fulfilled' | 'cancelled'
/** Only 'sent' is set by hand — 'partial' and 'paid' follow the payment ledger. */
export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'void'
/** How a line's price was revised: a percentage off, or a replacement unit price. */
export type RevisedRateType = 'percent' | 'fixed'
export type ActivityType = 'call' | 'email' | 'meeting' | 'note' | 'task'
export type RelatedToType = 'contact' | 'company' | 'deal'
export type ImportStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type FilterEntityType =
  | 'contact'
  | 'company'
  | 'deal'
  | 'campaign'
  | 'product'
  | 'marketplace'
export type ScoreCondition =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'is_filled'
  | 'is_empty'
  | 'greater_than'
  | 'less_than'
export type AssignmentStrategy = 'round_robin' | 'by_source' | 'fixed_user'
export type CustomFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect'

/**
 * Which card on a record a field is rendered under. Contacts and companies
 * share the first four; 'pricing' belongs to products alone.
 */
export type ContactCard =
  | 'details'
  | 'influence'
  | 'additional'
  | 'digital'
  | 'pricing'
  /** Companies only: what kind of business this is, rather than how to reach it. */
  | 'rating'

/** Palette a select option's colour is drawn from (mapped to classes in lib/field-options.ts). */
export type OptionColor =
  | 'slate'
  | 'blue'
  | 'green'
  | 'amber'
  | 'red'
  | 'violet'
  | 'cyan'
  | 'rose'
  | 'orange'
  | 'teal'

/** The built-in option lists an organization configures for its records. */
export type OptionFieldKey =
  /** Labelled "Merchandise" on screen — what category of goods they deal in. */
  | 'specialty_market'
  /** What condition the goods arrive in: overstock, customer returns, shelf pulls. */
  | 'stock_type'
  | 'customer_type'
  /** Where a selling account stands with the platform: Active, Paused, Closed. */
  | 'marketplace_account_status'
  | 'marketplace_type'
  | 'marketplace_fulfilment'
  | 'marketplace_payment'
  | 'marketplace_selling_cost'
  | 'marketplace_audience'
  | 'marketplace_inventory_type'
  | 'role_type'
  | 'priority'
  | 'credibility'
  | 'product_category'
  | 'product_type'
  | 'product_condition'
  | 'product_status'
  | 'loss_reason'

/** A named link on the Digital card, beyond the known social networks. */
export type ContactLink = { label: string; url: string }

/** A labelled postal address on a company. */
export type CompanyAddress = { label: string; address: string }

type Row<T> = T
type Insert<T, Optional extends keyof T> = Omit<T, Optional> & Partial<Pick<T, Optional>>

export type OrganizationRow = {
  id: string
  name: string
  slug: string
  status: OrgStatus
  logo_url: string | null
  primary_color: string
  default_currency: string
  /**
   * IANA zone. The one clock this organization's reports are read against —
   * an instant becomes a calendar day here and nowhere else, so two people in
   * different cities see the same figure. See lib/timezone.ts.
   */
  timezone: string
  created_at: string
}

export type UserRow = {
  id: string
  organization_id: string
  email: string
  name: string
  role: UserRole
  auth_provider_id: string | null
  status: UserStatus
  /**
   * The permission set this person is on. Null resolves through their role
   * instead — see current_permissions() in 20260235000000.
   */
  permission_set_id: string | null
  last_login_at: string | null
  created_at: string
}

/**
 * A named bundle of capabilities belonging to an organization.
 *
 * These columns are what the row-level policies actually consult, through the
 * eight `can_…` and `is_org_admin` helpers. Five are seeded per organization,
 * one per role, matching what each role could do before they existed.
 */
export type PermissionSetRow = {
  id: string
  organization_id: string
  name: string
  /** Which role resolves here for a user with no set of their own. */
  role: UserRole | null
  see_all_records: boolean
  see_unassigned: boolean
  write_records: boolean
  delete_records: boolean
  manage_records: boolean
  bulk_records: boolean
  administer: boolean
  /**
   * May edit these sets and assign people to them. Deliberately not implied by
   * `administer` — otherwise anybody who can reach Settings can grant
   * themselves anything, and every other column is advisory.
   */
  manage_permissions: boolean
  /** Sees hidden contacts and companies, and may hide or unhide them. */
  see_hidden: boolean
  created_at: string
  updated_at: string
}

/**
 * How a particular shape of file was read last time.
 *
 * Matched by `signature` — the headings, sorted and joined — rather than by the
 * file's name, because a list arrives called something different every month
 * while its columns stay put. See 20260239000000.
 */
export type ImportProfileRow = {
  id: string
  organization_id: string
  name: string
  signature: string
  headers: string[]
  /** Column heading to target key. */
  mapping: Record<string, string>
  /** Per option field, spelling to spelling. A correction table, not a whitelist. */
  value_merges: Record<string, Record<string, string>>
  placeholders: string[]
  times_used: number
  last_used_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type ContactRow = {
  id: string
  organization_id: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  company_id: string | null
  owner_id: string | null
  lifecycle_stage: LifecycleStage
  source: string | null
  custom_fields: Record<string, Json>
  lead_score: number
  duplicate_of_id: string | null
  job_title: string | null
  office_phone: string | null
  /** A second address, kept but never sent to — see 20260260000000. */
  secondary_email: string | null
  role_type: string[]
  priority: string | null
  credibility: string | null
  birthday: string | null
  /** Markdown, rendered through renderMarkdown() — never raw HTML. */
  notes: string | null
  website: string | null
  facebook: string | null
  instagram: string | null
  tiktok: string | null
  x_twitter: string | null
  youtube: string | null
  linkedin: string | null
  links: ContactLink[]
  /** Whether they may be sent marketing email, and on what basis. */
  marketing_consent: MarketingConsent
  /** Where that consent came from, in words somebody could defend later. */
  consent_source: string | null
  /** When it was given. Implied consent ages out from here. */
  consent_at: string | null
  unsubscribed_at: string | null
  /** The secret in their unsubscribe link. Random, so a leaked link says nothing. */
  unsubscribe_token: string
  /** null follows the consent rules, true vouches, false excludes. Cannot beat an unsubscribe or a bounce. */
  mailable_override: boolean | null
  mailable_override_at: string | null
  mailable_override_by: string | null
  created_by: string | null
  updated_by: string | null
  /** Soft delete. Only an administrator sees a stamped record. */
  deleted_at: string | null
  deleted_by: string | null
  /**
   * Out of sight for everybody without see_hidden — including the record's own
   * owner. Not a delete: the record is whole, and its deals and activities stay
   * visible with the record behind them unreadable. See 20260237000000.
   */
  hidden: boolean
  hidden_at: string | null
  hidden_by: string | null
  created_at: string
  updated_at: string
}

export type FieldOptionRow = {
  id: string
  organization_id: string
  entity_type: FilterEntityType
  /** A built-in OptionFieldKey, or a custom field's own key. */
  field_key: string
  value: string
  color: OptionColor
  order: number
  created_at: string
}

/** How, and on what basis, a contact may be sent marketing email. */
export type MarketingConsent = 'express' | 'implied' | 'none' | 'unsubscribed'

export type EmailSuppressionRow = {
  id: string
  organization_id: string
  email: string
  reason: 'unsubscribed' | 'bounced' | 'complained' | 'manual'
  note: string | null
  contact_id: string | null
  created_at: string
}

export type EmailListRow = {
  id: string
  organization_id: string
  name: string
  description: string | null
  /** Where the audience came from — the answer to "on what basis were these people mailed". */
  source_note: string | null
  /** Set means the list re-reads itself at send time; null means an explicit set of people. */
  saved_filter_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** The From address an organization's campaigns go out as. One per account. */
export type SendingDomainRow = {
  id: string
  organization_id: string
  domain: string
  from_name: string
  from_local: string
  reply_to: string | null
  postal_address: string | null
  provider_id: string | null
  verified: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export type EmailListMemberRow = {
  id: string
  organization_id: string
  list_id: string
  contact_id: string
  added_by: string | null
  added_at: string
}

/** One row per live contact; blocked_reason is null when they may be emailed. */
export type ContactMailabilityRow = {
  contact_id: string
  organization_id: string
  email: string | null
  marketing_consent: MarketingConsent
  consent_at: string | null
  mailable_override: boolean | null
  blocked_reason:
    | 'no_email'
    | 'unsubscribed'
    | 'suppressed'
    | 'excluded'
    | 'no_consent'
    | 'consent_expired'
    | null
}

/** The same vocabulary the database uses, so a reason survives the round trip. */
export type BlockedReason = NonNullable<ContactMailabilityRow['blocked_reason']> | 'unknown'

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'paused' | 'failed'

export type CampaignRow = {
  id: string
  organization_id: string
  name: string
  subject: string
  /** Markdown, rendered by the same renderer the test send uses. */
  body: string
  list_id: string | null
  status: CampaignStatus
  scheduled_at: string | null
  started_at: string | null
  finished_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type CampaignRecipientStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'skipped'

/** The outbox: one row per contact per campaign, written when it is scheduled. */
export type CampaignRecipientRow = {
  id: string
  organization_id: string
  campaign_id: string
  contact_id: string
  /** The address as it was when the audience was built, not as it is now. */
  email: string
  status: CampaignRecipientStatus
  skip_reason: string | null
  provider_id: string | null
  error: string | null
  claimed_at: string | null
  sent_at: string | null
  delivered_at: string | null
  opened_at: string | null
  clicked_at: string | null
  created_at: string
}

/**
 * One claimed row, with everything the sender needs to build the message.
 *
 * Flat and denormalised on purpose: the drain runs without a session, so it
 * cannot read these tables through RLS, and one query that returns the whole
 * message beats five that each need their own permission story.
 */
export type ClaimedRecipientRow = {
  recipient_id: string
  campaign_id: string
  contact_id: string
  email: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  unsubscribe_token: string | null
  subject: string
  body: string
  organization_id: string
  organization_name: string
  logo_url: string | null
  from_name: string | null
  from_address: string | null
  reply_to: string | null
  postal_address: string | null
  /** Re-checked at claim time; non-null means do not send after all. */
  blocked_reason: BlockedReason | null
}

export type CompanyRow = {
  id: string
  organization_id: string
  name: string
  /**
   * Customer ID — a short, stable handle derived from the name when the row is
   * created. See 20260264000000: it is set once and does not follow a rename.
   */
  code: string | null
  /** The company's website. Surfaced as "Website", kept as `domain` so existing rows and imports still line up. */
  domain: string | null
  /** Superseded by specialty_market; retained so older rows keep their value. */
  industry: string | null
  /**
   * How much this account matters.
   *
   * Its own list rather than the contacts' one, seeded to match it: a Critical
   * account can have a Standard person at it, and one list would make those the
   * same statement. See 20260247000000.
   */
  priority: string | null
  owner_id: string | null
  custom_fields: Record<string, Json>
  phone: string | null
  email: string | null
  /** Markdown, rendered through renderMarkdown() — never raw HTML. */
  notes: string | null
  specialty_market: string[]
  /** What condition of goods they deal in. See stock_type in field-options.ts. */
  stock_type: string[]
  /**
   * Where the company is, and where it trades — three separate facts.
   *
   * ISO 3166: `based_in` is alpha-2 — a country, or one of the trading regions from the
   * CA-QC, and the two territories are lists of alpha-2 codes. Deliberately not
   * an organization-editable option list, because a list somebody can edit ends
   * up holding "USA", "U.S.A." and "United States" as three separate countries.
   *
   * The territories are always stored sorted and de-duplicated, which is what
   * makes `sells_in = ['CA','US']` mean "exactly these two".
   */
  based_in: string | null
  sells_in: string[]
  sources_in: string[]
  customer_type: string[]
  linkedin: string | null
  facebook: string | null
  instagram: string | null
  tiktok: string | null
  x_twitter: string | null
  youtube: string | null
  links: ContactLink[]
  addresses: CompanyAddress[]
  created_by: string | null
  updated_by: string | null
  deleted_at: string | null
  deleted_by: string | null
  /**
   * Out of sight for everybody without see_hidden — including the record's own
   * owner. Not a delete: the record is whole, and its deals and activities stay
   * visible with the record behind them unreadable. See 20260237000000.
   */
  hidden: boolean
  hidden_at: string | null
  hidden_by: string | null
  created_at: string
  updated_at: string
}

/**
 * A linked mailbox, as the application is allowed to see it.
 *
 * refresh_token is deliberately absent: `authenticated` holds no grant on that
 * column, so a `select('*')` is refused by the database. Select the named
 * columns instead — the type mirrors what is actually readable.
 */
export type MailboxConnectionRow = {
  id: string
  organization_id: string
  user_id: string
  provider: 'gmail'
  email_address: string
  /** Gmail's incremental cursor. Null means the next run backfills. */
  history_id: string | null
  backfill_days: number
  /** How far back the history import has reached. Null = not started. */
  backfill_until: string | null
  /** Whether this connection's grant covers the calendar. */
  calendar_state: 'unknown' | 'active' | 'unauthorised'
  status: 'active' | 'needs_reauth' | 'disabled'
  last_error: string | null
  last_synced_at: string | null
  messages_logged: number
  created_at: string
  updated_at: string
}

export type NotificationRow = {
  id: string
  organization_id: string
  user_id: string
  kind: string
  title: string
  body: string | null
  link: string | null
  read_at: string | null
  created_at: string
}

export type CompanyTagRow = {
  organization_id: string
  company_id: string
  tag_id: string
  created_at: string
}

export type ProductTagRow = {
  organization_id: string
  product_id: string
  tag_id: string
  created_at: string
}

export type PipelineRow = {
  id: string
  organization_id: string
  name: string
  is_default: boolean
  /** Position in the pipeline bar. Contiguous from 0; see reorder_pipeline(). */
  order: number
  /**
   * Retired. Hidden from the board, the pipeline bar and every picker, with its
   * stage history intact — see 20260234000000. Null means live.
   */
  archived_at: string | null
  created_at: string
}

export type StageOutcome = 'open' | 'won' | 'lost'

export type StageRow = {
  id: string
  organization_id: string
  pipeline_id: string
  name: string
  order: number
  default_probability: number
  /**
   * What reaching this stage means for the deal. Moving a deal into a stage
   * applies this to its status — see 20260224000000. 'open' is the ordinary
   * working stage and says nothing.
   */
  outcome: StageOutcome
  /** Retired, exactly as on a pipeline. Null means live. */
  archived_at: string | null
  created_at: string
}

export type DealRow = {
  id: string
  organization_id: string
  name: string
  contact_id: string | null
  company_id: string | null
  stage_id: string
  value: number
  currency: string
  probability: number
  probability_overridden: boolean
  /**
   * Where `value` comes from. 'products' means it is the sum of the deal's line
   * items and is kept in step automatically; 'manual' means somebody typed it.
   */
  value_source: DealValueSource
  expected_close_date: string | null
  actual_close_date: string | null
  /** Free-form markdown about the deal. */
  notes: string | null
  status: DealStatus
  owner_id: string | null
  /**
   * Who owned the deal at the moment it closed, and who closed it. Reporting
   * reads closed_owner_id rather than owner_id, so handing an account to a
   * colleague afterwards does not move the win with it.
   */
  closed_owner_id: string | null
  closed_by: string | null
  closed_at: string | null
  /** Why a lost deal was lost. Offered from field_options (deal / loss_reason). */
  loss_reason: string | null
  /** Organization-defined values, keyed by custom_field_definitions.key. */
  custom_fields: Record<string, unknown>
  position: number
  /** Set means the deal is in the recycle bin: only an admin sees it. */
  deleted_at: string | null
  deleted_by: string | null
  /** Stamped by the database on write — see stamp_deal_actor in 20260256. */
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type ProductRow = {
  id: string
  organization_id: string
  name: string
  sku: string | null
  /** Drawn from field_options, like every other select field. */
  category: string | null
  /** Retired from the form. Kept so old line items still render their measure. */
  unit: string
  /** Unit $: Retail. What a deal line item copies when the product is added. */
  unit_price: number
  /** Unit $: Cost. */
  unit_cost: number
  currency: string
  /** Markdown, rendered through renderMarkdown() — never raw HTML. */
  description: string | null
  custom_fields: Record<string, Json>
  /**
   * Derived from `status` by a trigger — offered on new deals, or not. Read it
   * freely; never write it. Set the status instead.
   */
  active: boolean

  // What it is
  brand: string | null
  model: string | null
  /** "24 ct", "500 ml" — text, because that is how it arrives. */
  item_count: string | null
  size: string | null
  color: string | null
  /** Pieces to a unit. Divides the unit prices into piece prices. */
  case_pack: number | null
  /** Markdown, rendered through renderMarkdown() — never raw HTML. */
  item_notes: string | null
  /*
   * All three are drawn from field_options, like category — an organization
   * edits them in Settings → Fields, so no union type here could stay true.
   * Only one value is load-bearing: "Active" is what `active` is derived from.
   */
  product_type: string | null
  product_condition: string | null
  status: string
  /** Drawn from the product priority list, the same question a contact and a company are asked. */
  priority: string | null

  /*
   * Prices nobody typed. Null means "derive it" — 70% and 30% of retail for the
   * showroom and wholesale unit prices, and the matching unit price ÷ case pack
   * for each piece price. derivePricing() in src/lib/products.ts is the rule,
   * and reading these columns raw will give you holes rather than a price list.
   */
  price_showroom: number | null
  price_wholesale: number | null
  piece_price_retail: number | null
  piece_price_showroom: number | null
  piece_price_wholesale: number | null
  /** A pallet is priced by negotiation; there is no rule to fall back on. */
  pallet_price_retail: number | null
  pallet_price_wholesale: number | null
  piece_cost: number | null
  pallet_cost: number | null

  /** Rendered through safeUrl(), never straight into an href. */
  barcode_url: string | null
  comp_1_url: string | null
  comp_2_url: string | null
  /** Wherever the paperwork lives — Drive, Dropbox, a network share. */
  folder_url: string | null
  /** The spec sheet, the manual, the internal write-up. */
  knowledge_base_url: string | null

  /**
   * Object key in the product-images bucket, not a URL — productImageUrl()
   * builds the URL. Storing the whole thing would bake this project's hostname
   * into every row and leave dead links behind a restore or a move.
   */
  image_path: string | null
  created_by: string | null
  updated_by: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

/**
 * A product on a deal, at the price it was sold for.
 *
 * unit_price and unit_cost are copied from the product when the line is added
 * and never follow it afterwards, so re-pricing the catalogue cannot rewrite
 * what a closed deal was worth. Amounts are in the deal's currency.
 */
export type DealProductRow = {
  id: string
  organization_id: string
  deal_id: string
  product_id: string
  quantity: number
  unit_price: number
  unit_cost: number
  discount_pct: number
  /** Generated in the database — never written by the application. */
  line_total: number
  line_cost: number
  position: number
  created_at: string
  updated_at: string
}

/**
 * A sales order: what a customer actually bought.
 *
 * Deliberately unrelated to a deal — there is no deal_id here and no foreign
 * key between the two. A deal asks whether we will win the business; this
 * records that we did and what it consisted of. See
 * docs/SALES_ORDERS_INVOICES.md.
 */
export type SalesOrderRow = {
  id: string
  organization_id: string
  /** PO-Acme-0001. Allocated once at creation and never reissued. */
  number: string
  company_id: string | null
  contact_id: string | null
  /**
   * Where the goods go, when that is not the company being billed — a broker
   * buys and a warehouse receives. Null means the same as bill to.
   */
  ship_to_company_id: string | null
  ship_to_contact_id: string | null
  /** The delivery address as it should print, which is not always the company's. */
  shipping_address: string | null
  shipping_method: string | null
  /** Who arranges and pays for carriage. */
  shipping_responsibility: string | null
  /** Whether money is needed down. The deposits actually taken are their own rows. */
  deposit_required: boolean
  deposit_information: string | null
  owner_id: string | null
  location_id: string | null
  status: SalesOrderStatus
  currency: string
  /**
   * The channel this sold through, or null for a direct sale.
   *
   * Points at the company, not its marketplace profile: a profile can be
   * removed, and an order sold through a channel in March was still sold
   * through it after somebody stops listing there in June.
   */
  marketplace_id: string | null
  order_date: string
  payment_terms: string | null
  shipping_charge: number
  notes: string | null
  terms: string | null
  /** Stamped when the order is first reserved — signed, or a deposit taken. */
  signed_at: string | null
  created_by: string | null
  updated_by: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

/**
 * One line of a sales order, at the price it was sold for.
 *
 * A line names a product or carries its own description — a one-off does not
 * need a catalogue entry. discount is written by a database trigger from the
 * revised rate, and line_total is generated from it, so neither can be sent by
 * a client.
 */
export type SalesOrderLineRow = {
  id: string
  organization_id: string
  sales_order_id: string
  product_id: string | null
  description: string | null
  notes: string | null
  /** The line's own unit of measure; null falls back to the product's. */
  unit: string | null
  quantity: number
  unit_price: number
  unit_cost: number
  revised_rate_type: RevisedRateType | null
  revised_rate: number | null
  /** Derived in the database — never written by the application. */
  discount: number
  line_total: number
  line_cost: number
  position: number
  created_at: string
  updated_at: string
}

/**
 * A deposit on a sales order, or a reversal of one.
 *
 * Append-only: positive is money in, negative reverses an earlier row, and
 * nothing is ever edited or deleted. There is no update policy on the table, so
 * that is a guarantee rather than a convention.
 */
export type SalesOrderPaymentRow = {
  id: string
  organization_id: string
  sales_order_id: string
  amount: number
  method: string | null
  note: string | null
  paid_at: string
  created_by: string | null
  created_at: string
}

/**
 * An invoice: a snapshot, not a view.
 *
 * Its totals are stored and its lines carry the product's name as text, so
 * editing the order afterwards does not move it. amount_paid is maintained by
 * the payment ledger's trigger and by nothing else.
 */
export type InvoiceRow = {
  id: string
  organization_id: string
  number: string
  sales_order_id: string | null
  company_id: string | null
  contact_id: string | null
  owner_id: string | null
  /** The salesperson's name as it read at issue. */
  owner_name: string | null
  status: InvoiceStatus
  currency: string
  /**
   * The channel this sold through, or null for a direct sale.
   *
   * Points at the company, not its marketplace profile: a profile can be
   * removed, and an order sold through a channel in March was still sold
   * through it after somebody stops listing there in June.
   */
  marketplace_id: string | null
  issue_date: string
  due_date: string | null
  subtotal: number
  shipping_charge: number
  total: number
  amount_paid: number
  payment_terms: string | null
  notes: string | null
  terms: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** One line of an invoice, frozen at issue. Written only by the conversion. */
export type InvoiceLineRow = {
  id: string
  organization_id: string
  invoice_id: string
  product_id: string | null
  name: string
  sku: string | null
  notes: string | null
  quantity: number
  unit_price: number
  unit_cost: number
  discount: number
  line_total: number
  position: number
  created_at: string
}

/** A payment on an invoice, or a reversal. Append-only, like the deposits. */
export type InvoicePaymentRow = {
  id: string
  organization_id: string
  invoice_id: string
  amount: number
  method: string | null
  note: string | null
  paid_at: string
  created_by: string | null
  created_at: string
}

/** What a contact has asked about. Intent, not purchase history. */
/** A warehouse. Org-wide reference data: everyone reads, managers arrange. */
export type StockLocationRow = {
  id: string
  organization_id: string
  name: string
  /** A short label for tables and pickers — "TOR", "MTL-3". */
  code: string | null
  address: string | null
  active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

/** A shelf, a rack, an aisle. Optional, and belongs to exactly one location. */
export type StockBinRow = {
  id: string
  organization_id: string
  location_id: string
  name: string
  created_at: string
}

/**
 * How many of a product are in one place.
 *
 * Read freely; never written directly — `authenticated` holds SELECT and
 * nothing else. Every change goes through the set_stock_level RPC, which writes
 * the adjustment beside it in the same statement.
 */
export type StockLevelRow = {
  id: string
  organization_id: string
  product_id: string
  location_id: string
  bin_id: string | null
  quantity: number
  /**
   * Held back by hand, for a reason that is not a deal yet. Not constrained to
   * be within `quantity`: a count that falls below what was already reserved is
   * a real situation, and refusing the correction would leave the wrong number
   * on the record. The form points it out rather than blocking it.
   */
  reserved: number
  /**
   * A standing note about this place: a damaged pallet, a recount pending,
   * whose floor it is on. Describes the place as it stands and is meant to be
   * revised — unlike StockAdjustmentRow.note, which explains one movement and
   * is written once.
   */
  note: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

/** Append-only. What moved, by how much, why, and who did it. */
export type StockAdjustmentRow = {
  id: string
  organization_id: string
  product_id: string
  location_id: string | null
  bin_id: string | null
  field: 'quantity' | 'reserved'
  delta: number
  quantity_after: number
  reason: string | null
  note: string | null
  created_by: string | null
  created_at: string
}

export type ActivityRow = {
  id: string
  organization_id: string
  type: ActivityType
  related_to_type: RelatedToType
  related_to_id: string
  owner_id: string | null
  subject: string
  body: string | null
  due_date: string | null
  completed_at: string | null
  external_source: string | null
  external_id: string | null
  occurred_at: string
  created_at: string
}

export type TagRow = {
  id: string
  organization_id: string
  name: string
  color: string
  created_at: string
}

export type ContactTagRow = {
  organization_id: string
  contact_id: string
  tag_id: string
  created_at: string
}

export type SavedFilterRow = {
  id: string
  organization_id: string
  user_id: string | null
  entity_type: FilterEntityType
  name: string
  filter_json: Json
  is_shared: boolean
  created_at: string
}

export type ImportJobRow = {
  id: string
  organization_id: string
  user_id: string | null
  entity_type: FilterEntityType
  status: ImportStatus
  file_name: string
  field_mapping: Json
  options: Json
  rows_processed: number
  rows_failed: number
  errors: Json
  created_at: string
  completed_at: string | null
}

export type LeadScoreRuleRow = {
  id: string
  organization_id: string
  field: string
  condition: ScoreCondition
  value: string | null
  points: number
  is_active: boolean
  created_at: string
}

export type AssignmentRuleRow = {
  id: string
  organization_id: string
  name: string
  strategy: AssignmentStrategy
  source_match: string | null
  fixed_user_id: string | null
  last_assigned_id: string | null
  priority: number
  is_active: boolean
  created_at: string
}

export type CustomFieldDefinitionRow = {
  id: string
  organization_id: string
  entity_type: FilterEntityType
  key: string
  label: string
  field_type: CustomFieldType
  options: Json
  order: number
  card: ContactCard
  created_at: string
}

export type PipelineValueReportRow = {
  stage_id: string
  stage_name: string
  stage_order: number
  pipeline_id: string
  pipeline_name: string
  owner_id: string | null
  owner_name: string | null
  deal_count: number
  total_value: number
  weighted_value: number
}

/** One row per product per currency — currencies are never added together. */
export type ProductMixReportRow = {
  product_id: string
  product_name: string
  category: string | null
  currency: string
  deal_count: number
  total_quantity: number
  total_value: number
  weighted_value: number
  total_cost: number
  margin: number
}

export type DuplicateGroupRow = {
  match_key: string
  match_type: string
  contact_ids: string[]
  contact_count: number
}

type TableDef<TRow, TOptional extends keyof TRow> = {
  Row: Row<TRow>
  Insert: Insert<TRow, TOptional>
  Update: Partial<TRow>
  Relationships: []
}

export interface Database {
  public: {
    Tables: {
      organizations: TableDef<
        OrganizationRow,
        | 'id'
        | 'status'
        | 'logo_url'
        | 'primary_color'
        | 'default_currency'
        | 'timezone'
        | 'created_at'
      >
      users: TableDef<
        UserRow,
        | 'id'
        | 'name'
        | 'role'
        | 'auth_provider_id'
        | 'status'
        | 'permission_set_id'
        | 'last_login_at'
        | 'created_at'
      >
      import_profiles: TableDef<
        ImportProfileRow,
        | 'id'
        | 'headers'
        | 'mapping'
        | 'value_merges'
        | 'placeholders'
        | 'times_used'
        | 'last_used_at'
        | 'created_by'
        | 'created_at'
        | 'updated_at'
      >
      permission_sets: TableDef<
        PermissionSetRow,
        | 'id'
        | 'role'
        | 'see_all_records'
        | 'see_unassigned'
        | 'write_records'
        | 'delete_records'
        | 'manage_records'
        | 'bulk_records'
        | 'administer'
        | 'manage_permissions'
        | 'see_hidden'
        | 'created_at'
        | 'updated_at'
      >
      contacts: TableDef<
        ContactRow,
        | 'id'
        | 'first_name'
        | 'last_name'
        | 'email'
        | 'phone'
        | 'company_id'
        | 'owner_id'
        | 'lifecycle_stage'
        | 'source'
        | 'custom_fields'
        | 'lead_score'
        | 'duplicate_of_id'
        | 'job_title'
        | 'office_phone'
        | 'secondary_email'
        | 'role_type'
        | 'priority'
        | 'credibility'
        | 'birthday'
        | 'notes'
        | 'website'
        | 'facebook'
        | 'instagram'
        | 'tiktok'
        | 'x_twitter'
        | 'youtube'
        | 'linkedin'
        | 'links'
        | 'created_by'
        | 'updated_by'
        | 'hidden'
        | 'hidden_at'
        | 'hidden_by'
        | 'deleted_at'
        | 'deleted_by'
        | 'created_at'
        | 'updated_at'
      >
      companies: TableDef<
        CompanyRow,
        | 'id'
        // Filled by a trigger from the name when absent — see 20260264000000.
        | 'code'
        | 'domain'
        | 'industry'
        | 'owner_id'
        | 'custom_fields'
        | 'phone'
        | 'email'
        | 'notes'
        | 'specialty_market'
        | 'stock_type'
        | 'based_in'
        | 'sells_in'
        | 'sources_in'
        | 'customer_type'
        | 'linkedin'
        | 'facebook'
        | 'instagram'
        | 'tiktok'
        | 'x_twitter'
        | 'youtube'
        | 'links'
        | 'addresses'
        | 'created_by'
        | 'updated_by'
        | 'hidden'
        | 'hidden_at'
        | 'hidden_by'
        | 'deleted_at'
        | 'deleted_by'
        | 'created_at'
        | 'updated_at'
      >
      notifications: TableDef<NotificationRow, 'id' | 'body' | 'link' | 'read_at' | 'created_at'>
      mailbox_connections: TableDef<
        MailboxConnectionRow,
        | 'id'
        | 'provider'
        | 'history_id'
        | 'backfill_days'
        | 'backfill_until'
        | 'calendar_state'
        | 'status'
        | 'last_error'
        | 'last_synced_at'
        | 'messages_logged'
        | 'created_at'
        | 'updated_at'
      >
      company_tags: TableDef<CompanyTagRow, 'organization_id' | 'created_at'>
      product_tags: TableDef<ProductTagRow, 'organization_id' | 'created_at'>
      pipelines: TableDef<PipelineRow, 'id' | 'is_default' | 'order' | 'archived_at' | 'created_at'>
      stages: TableDef<
        StageRow,
        'id' | 'organization_id' | 'order' | 'default_probability' | 'archived_at' | 'created_at'
      >
      deals: TableDef<
        DealRow,
        | 'id'
        | 'contact_id'
        | 'company_id'
        | 'value'
        | 'currency'
        | 'probability'
        | 'probability_overridden'
        | 'value_source'
        | 'expected_close_date'
        | 'actual_close_date'
        | 'notes'
        | 'status'
        | 'owner_id'
        | 'position'
        | 'created_by'
        | 'updated_by'
        | 'created_at'
        | 'updated_at'
      >
      activities: TableDef<
        ActivityRow,
        | 'id'
        | 'owner_id'
        | 'subject'
        | 'body'
        | 'due_date'
        | 'completed_at'
        | 'external_source'
        | 'external_id'
        | 'occurred_at'
        | 'created_at'
      >
      products: TableDef<
        ProductRow,
        | 'id'
        | 'sku'
        | 'category'
        | 'priority'
        | 'unit'
        | 'unit_price'
        | 'unit_cost'
        | 'currency'
        | 'description'
        | 'custom_fields'
        | 'active'
        | 'created_by'
        | 'updated_by'
        | 'deleted_at'
        | 'deleted_by'
        | 'created_at'
        | 'updated_at'
      >
      deal_products: TableDef<
        DealProductRow,
        | 'id'
        | 'quantity'
        | 'unit_price'
        | 'unit_cost'
        | 'discount_pct'
        | 'line_total'
        | 'line_cost'
        | 'position'
        | 'created_at'
        | 'updated_at'
      >
      sales_orders: TableDef<
        SalesOrderRow,
        | 'id'
        | 'number'
        | 'company_id'
        | 'contact_id'
        | 'owner_id'
        | 'location_id'
        | 'status'
        | 'currency'
        | 'order_date'
        | 'payment_terms'
        | 'shipping_charge'
        | 'ship_to_company_id'
        | 'ship_to_contact_id'
        | 'shipping_address'
        | 'shipping_method'
        | 'shipping_responsibility'
        | 'deposit_required'
        | 'deposit_information'
        | 'notes'
        | 'terms'
        | 'signed_at'
        | 'created_by'
        | 'updated_by'
        | 'deleted_at'
        | 'deleted_by'
        | 'created_at'
        | 'updated_at'
      >
      sales_order_lines: TableDef<
        SalesOrderLineRow,
        | 'id'
        | 'product_id'
        | 'description'
        | 'notes'
        | 'unit'
        | 'quantity'
        | 'unit_price'
        | 'unit_cost'
        | 'revised_rate_type'
        | 'revised_rate'
        // Derived in the database. Present on a read, never sent on a write.
        | 'discount'
        | 'line_total'
        | 'line_cost'
        | 'position'
        | 'created_at'
        | 'updated_at'
      >
      sales_order_payments: TableDef<
        SalesOrderPaymentRow,
        'id' | 'method' | 'note' | 'paid_at' | 'created_by' | 'created_at'
      >
      invoices: TableDef<
        InvoiceRow,
        | 'id'
        | 'number'
        | 'sales_order_id'
        | 'company_id'
        | 'contact_id'
        | 'owner_id'
        | 'owner_name'
        | 'status'
        | 'currency'
        | 'issue_date'
        | 'due_date'
        | 'subtotal'
        | 'shipping_charge'
        | 'total'
        | 'amount_paid'
        | 'payment_terms'
        | 'notes'
        | 'terms'
        | 'created_by'
        | 'created_at'
        | 'updated_at'
      >
      invoice_lines: TableDef<
        InvoiceLineRow,
        | 'id'
        | 'product_id'
        | 'sku'
        | 'notes'
        | 'unit_cost'
        | 'discount'
        | 'position'
        | 'created_at'
      >
      invoice_payments: TableDef<
        InvoicePaymentRow,
        'id' | 'method' | 'note' | 'paid_at' | 'created_by' | 'created_at'
      >
      tags: TableDef<TagRow, 'id' | 'color' | 'created_at'>
      contact_tags: TableDef<ContactTagRow, 'organization_id' | 'created_at'>
      saved_filters: TableDef<
        SavedFilterRow,
        'id' | 'user_id' | 'entity_type' | 'filter_json' | 'is_shared' | 'created_at'
      >
      import_jobs: TableDef<
        ImportJobRow,
        | 'id'
        | 'user_id'
        | 'entity_type'
        | 'status'
        | 'file_name'
        | 'field_mapping'
        | 'options'
        | 'rows_processed'
        | 'rows_failed'
        | 'errors'
        | 'created_at'
        | 'completed_at'
      >
      lead_score_rules: TableDef<LeadScoreRuleRow, 'id' | 'value' | 'points' | 'is_active' | 'created_at'>
      assignment_rules: TableDef<
        AssignmentRuleRow,
        | 'id'
        | 'strategy'
        | 'source_match'
        | 'fixed_user_id'
        | 'last_assigned_id'
        | 'priority'
        | 'is_active'
        | 'created_at'
      >
      custom_field_definitions: TableDef<
        CustomFieldDefinitionRow,
        'id' | 'entity_type' | 'field_type' | 'options' | 'order' | 'card' | 'created_at'
      >
      field_options: TableDef<FieldOptionRow, 'id' | 'entity_type' | 'color' | 'order' | 'created_at'>
    }
    Views: Record<string, never>
    Functions: {
      recalculate_lead_scores: { Args: Record<string, never>; Returns: number }
      find_duplicate_contacts: {
        Args: {
          p_email?: string | null
          p_first_name?: string | null
          p_last_name?: string | null
          p_phone?: string | null
          p_exclude_id?: string | null
        }
        Returns: ContactRow[]
      }
      find_duplicate_groups: { Args: Record<string, never>; Returns: DuplicateGroupRow[] }
      merge_contacts: { Args: { p_target_id: string; p_source_id: string }; Returns: ContactRow }
      next_assignee: { Args: { p_source?: string | null }; Returns: string | null }
      report_pipeline_value: {
        Args: { p_pipeline_id?: string | null; p_owner_id?: string | null }
        Returns: PipelineValueReportRow[]
      }
      create_birthday_reminders: { Args: { p_days_ahead?: number }; Returns: number }
      reassign_contact: { Args: { p_contact_id: string; p_new_owner_id: string | null }; Returns: void }
      report_product_mix: {
        Args: { p_pipeline_id?: string | null; p_status?: DealStatus | null }
        Returns: ProductMixReportRow[]
      }
      set_deal_value_from_products: { Args: { p_deal_id: string }; Returns: void }
      reorder_stage: { Args: { p_stage_id: string; p_position: number }; Returns: void }
      move_stage: { Args: { p_stage_id: string; p_delta: number }; Returns: void }
      reorder_pipeline: { Args: { p_pipeline_id: string; p_position: number }; Returns: void }
      move_pipeline: { Args: { p_pipeline_id: string; p_delta: number }; Returns: void }
      /**
       * Deletes a pipeline nothing refers to, archives one something does, and
       * says which — see 20260234000000.
       */
      /** The caller's permission set — their own if assigned, otherwise their role's. */
      current_permissions: { Args: Record<string, never>; Returns: PermissionSetRow | null }
      /** Deals per set, counting people who resolve to it by role as well. */
      permission_set_members: {
        Args: Record<string, never>
        Returns: { permission_set_id: string; members: number }[]
      }
      save_import_profile: {
        Args: {
          p_name: string
          p_signature: string
          p_headers: string[]
          p_mapping: Record<string, string>
          p_value_merges: Record<string, Record<string, string>>
          p_placeholders: string[]
        }
        Returns: string
      }
      create_permission_set: { Args: { p_name: string }; Returns: string }
      update_permission_set: {
        Args: {
          p_id: string
          p_name: string
          p_see_all_records: boolean
          p_see_unassigned: boolean
          p_write_records: boolean
          p_delete_records: boolean
          p_manage_records: boolean
          p_bulk_records: boolean
          p_administer: boolean
          p_manage_permissions: boolean
          p_see_hidden: boolean
        }
        Returns: void
      }
      delete_permission_set: { Args: { p_id: string }; Returns: void }
      assign_permission_set: { Args: { p_user_id: string; p_set_id: string | null }; Returns: void }
      remove_pipeline: { Args: { p_pipeline_id: string }; Returns: 'deleted' | 'archived' }
      restore_pipeline: { Args: { p_pipeline_id: string }; Returns: void }
      remove_stage: { Args: { p_stage_id: string }; Returns: 'deleted' | 'archived' }
      restore_stage: { Args: { p_stage_id: string }; Returns: void }
      /** Deals per pipeline: open, closed, and in the recycle bin. */
      pipeline_usage: {
        Args: Record<string, never>
        Returns: { pipeline_id: string; open_deals: number; closed: number; binned: number }[]
      }
      bulk_set_consent: {
        Args: { p_ids: string[]; p_consent: string; p_source: string; p_at?: string }
        Returns: number
      }
      unsubscribe_by_token: { Args: { p_token: string }; Returns: boolean }
      unsubscribe_check: {
        Args: { p_token: string }
        Returns: { found: boolean; email: string | null; already: boolean }[]
      }
      /** Returns the number of rows actually changed, which is the count after RLS. */
      bulk_update_records: {
        Args: {
          p_entity: string
          p_ids: string[]
          p_field: string
          p_mode: string
          p_values: string[]
        }
        Returns: number
      }
      /** Allocates the SO number in the same transaction as the row it goes on. */
      create_sales_order: {
        Args: {
          p_company_id?: string | null
          p_contact_id?: string | null
          p_owner_id?: string | null
          p_currency?: string | null
        }
        Returns: string
      }
      /** Idempotent: returns the existing invoice when the order already has one. */
      convert_sales_order_to_invoice: { Args: { p_sales_order_id: string }; Returns: string }
      /** An empty draft invoice with no sales order behind it. */
      create_invoice: {
        Args: {
          p_company_id?: string | null
          p_contact_id?: string | null
          p_owner_id?: string | null
          p_currency?: string | null
        }
        Returns: string
      }
      /**
       * The only door onto invoice_lines besides the conversion. Refuses
       * anything that is not a draft raised on its own, and computes the
       * discount itself — a client never sends one.
       */
      add_invoice_line: {
        Args: {
          p_invoice_id: string
          p_product_id?: string | null
          p_name?: string | null
          p_quantity?: number
          p_unit_price?: number
          p_unit_cost?: number
          p_rate_type?: RevisedRateType | null
          p_rate?: number | null
          p_notes?: string | null
        }
        Returns: string
      }
      remove_invoice_line: { Args: { p_line_id: string }; Returns: void }
      soft_delete_sales_order: { Args: { p_sales_order_id: string }; Returns: void }
      restore_sales_order: { Args: { p_sales_order_id: string }; Returns: void }
      soft_delete_product: { Args: { p_product_id: string }; Returns: void }
      restore_product: { Args: { p_product_id: string }; Returns: void }
      soft_delete_contact: { Args: { p_contact_id: string }; Returns: void }
      soft_delete_company: { Args: { p_company_id: string }; Returns: void }
      restore_contact: { Args: { p_contact_id: string }; Returns: void }
      disconnect_mailbox: { Args: { p_connection_id: string }; Returns: void }
      set_mailbox_backfill: { Args: { p_connection_id: string; p_days: number }; Returns: void }
      restore_company: { Args: { p_company_id: string }; Returns: void }
      reassign_deal: { Args: { p_deal_id: string; p_new_owner_id: string | null }; Returns: void }
      contact_blocked_reason: { Args: { p_contact_id: string }; Returns: BlockedReason | null }
      build_campaign_audience: { Args: { p_campaign_id: string }; Returns: number }
      build_campaign_audience_for: {
        Args: { p_campaign_id: string; p_contact_ids: string[] }
        Returns: number
      }
      clear_campaign_audience: { Args: { p_campaign_id: string }; Returns: number }
      campaign_link_clicks: {
        Args: { p_campaign_id: string }
        Returns: { url: string; clicks: number; people: number }[]
      }
      claim_campaign_batch: { Args: { p_limit?: number }; Returns: ClaimedRecipientRow[] }
      finish_campaign_recipient: {
        Args: {
          p_recipient_id: string
          p_status: CampaignRecipientStatus
          p_provider_id?: string | null
          p_error?: string | null
          p_skip_reason?: string | null
        }
        Returns: void
      }
      settle_campaigns: { Args: Record<string, never>; Returns: number }
      start_due_campaigns: { Args: Record<string, never>; Returns: number }
      record_email_event: {
        Args: {
          p_provider_id: string | null
          p_event_type: string
          p_recipient: string | null
          p_payload: Json
        }
        Returns: void
      }
      can_manage_records: { Args: Record<string, never>; Returns: boolean }
      can_write_records: { Args: Record<string, never>; Returns: boolean }
      current_org_id: { Args: Record<string, never>; Returns: string }
      is_org_admin: { Args: Record<string, never>; Returns: boolean }
    }
    Enums: {
      org_status: OrgStatus
      user_role: UserRole
      user_status: UserStatus
      lifecycle_stage: LifecycleStage
      deal_status: DealStatus
      activity_type: ActivityType
      related_to_type: RelatedToType
      import_status: ImportStatus
      filter_entity_type: FilterEntityType
      score_condition: ScoreCondition
      assignment_strategy: AssignmentStrategy
      custom_field_type: CustomFieldType
    }
    CompositeTypes: Record<string, never>
  }
}

/**
 * One person's column choice for one list.
 *
 * Personal, and readable by nobody else — see 20260244000000. The keys are
 * strings the application resolves against its own catalogue rather than
 * references to anything, so a stale one degrades to a missing column instead
 * of blocking a custom field from being deleted.
 */
export type ColumnPreferenceRow = {
  id: string
  organization_id: string
  user_id: string
  /** 'contact' | 'company' | 'product'. */
  entity_type: string
  /** In display order. The order is the preference as much as the set is. */
  columns: string[]
  created_at: string
  updated_at: string
}

/**
 * What makes a company a marketplace.
 *
 * Keyed on the company: the company *is* the marketplace, and the presence of
 * this row is the whole answer to "is this one". Promoting inserts it, demoting
 * deletes it, and the company survives either way — see 20260245000000.
 */
export type MarketplaceProfileRow = {
  company_id: string
  organization_id: string
  /** AFM lists inventory here. Both directions can be true at once. */
  sells_through: boolean
  /** AFM buys inventory here. */
  sources_from: boolean
  store_name: string | null
  seller_account_id: string | null
  store_url: string | null
  account_status: string | null
  opened_on: string | null
  settlement_terms: string | null
  payout_method: string | null
  payout_currency: string | null
  reserve_percent: number | null
  minimum_lot_value: number | null
  notes: string | null
  /** What it costs to trade here, in prose. Markdown, never raw HTML. */
  fee_notes: string | null
  /** Standard, Auction. */
  marketplace_type: string[]
  /** Fulfilled by Platform, Fulfilled by Seller. */
  fulfilment: string[]
  /** Via Platform, Via Seller. */
  payment: string | null
  /** Null means nobody has recorded it. False means there is none. */
  buyers_premium: boolean | null
  /** High, Medium, Low — what the rate card was for, at the size it is used. */
  selling_cost: string | null
  /** B2B, B2C. */
  audience: string[]
  /** Unit, Lots. */
  inventory_type: string[]
  created_by: string | null
  created_at: string
  updated_at: string
}


