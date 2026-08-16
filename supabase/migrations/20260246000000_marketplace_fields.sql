-- =============================================================================
-- What actually matters about a marketplace
--
-- The rate card built in 20260245000000 is removed. Per-category percentages
-- were the answer to a question that turned out not to be worth asking: keeping
-- them true would mean maintaining a row per category per platform per
-- direction, and the decision they were meant to support — is this channel
-- expensive or cheap — needs three values, not three decimal places.
--
-- So the fees become a note somebody writes in their own words, and the
-- comparison becomes one coarse field. What replaces the machinery is the set
-- of things that actually distinguish one platform from another: whether it is
-- an auction, who ships, who takes the money, who buys there, and in what size.
--
-- The tables go rather than being left unused. Dead schema is worse than none:
-- it invites somebody to fill it in, and the next reader has to work out
-- whether it is load-bearing.
-- =============================================================================

drop function if exists public.set_marketplace_fee(uuid, text, text, numeric, numeric, numeric, text);
drop function if exists public.remove_marketplace_fee(uuid);
drop table if exists public.marketplace_fees;

alter table public.marketplace_profiles
  /*
   * Everything about cost, in whatever words fit. A platform's terms are prose
   * — "15% seller fee, 3% processing, $0.30 a listing, waived under $50" — and
   * prose is what a person writing it down actually has. Markdown, rendered
   * through renderMarkdown() like every other note in this schema; never raw
   * HTML.
   */
  add column if not exists fee_notes text,

  /** Standard, Auction. A platform can be both — some run buy-now beside lots. */
  add column if not exists marketplace_type text[] not null default '{}'::text[],
  /** Fulfilled by Platform, Fulfilled by Seller. Both, where it depends. */
  add column if not exists fulfilment text[] not null default '{}'::text[],
  /** Via Platform, Via Seller. One answer — the money takes one route. */
  add column if not exists payment text,
  /*
   * Nullable on purpose. False means "no premium"; null means nobody has said,
   * and a three-state answer is the honest shape for a field somebody has not
   * filled in yet.
   */
  add column if not exists buyers_premium boolean,
  /** High, Medium, Low. What the rate card was for, at the size it is used. */
  add column if not exists selling_cost text,
  /** B2B, B2C. Both, for a platform that serves trade and public. */
  add column if not exists audience text[] not null default '{}'::text[],
  /** Unit, Lots. */
  add column if not exists inventory_type text[] not null default '{}'::text[],
  /*
   * Drawn from the same list contacts use, so "Critical" means one thing across
   * the CRM rather than two. Not mirrored from the company, because a company
   * has no priority column to mirror — see the note at the foot of this file.
   */
  add column if not exists priority text;

comment on column public.marketplace_profiles.fee_notes is
  'What it costs to trade here, in prose. Markdown, rendered through renderMarkdown() — never raw HTML.';
comment on column public.marketplace_profiles.selling_cost is
  'High, Medium or Low. Replaces a per-category rate card: the decision it supports needs three values, not three decimal places.';
comment on column public.marketplace_profiles.buyers_premium is
  'Null means nobody has recorded it. False means there is none.';

-- -----------------------------------------------------------------------------
-- The vocabularies
--
-- field_options, like every other select list, so an organization can add
-- "Hybrid" or rename "Lots" to "Pallets" without a deployment. Seeded with the
-- values asked for and nothing invented beside them.
--
-- On the company entity, because a marketplace is a company. There is no
-- separate entity to hang them off, and inventing one would give companies a
-- list that only applies to some of them.
-- -----------------------------------------------------------------------------

insert into public.field_options (organization_id, entity_type, field_key, value, color, "order")
select o.id, 'company', v.field_key, v.value, v.color, v.ord
from public.organizations o
cross join (values
  ('marketplace_type', 'Standard',              'blue',   0),
  ('marketplace_type', 'Auction',               'violet', 1),

  ('marketplace_fulfilment', 'Fulfilled by Platform', 'teal', 0),
  ('marketplace_fulfilment', 'Fulfilled by Seller',   'cyan', 1),

  ('marketplace_payment', 'Via Platform', 'teal', 0),
  ('marketplace_payment', 'Via Seller',   'cyan', 1),

  -- Green is cheap and red is dear, so the colour says the same thing as the
  -- word and a scanned column reads without being read.
  ('marketplace_selling_cost', 'Low',    'green', 0),
  ('marketplace_selling_cost', 'Medium', 'amber', 1),
  ('marketplace_selling_cost', 'High',   'red',   2),

  ('marketplace_audience', 'B2B', 'blue',   0),
  ('marketplace_audience', 'B2C', 'orange', 1),

  ('marketplace_inventory_type', 'Unit', 'slate',  0),
  ('marketplace_inventory_type', 'Lots', 'violet', 1)
) as v(field_key, value, color, ord)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Saving one
--
-- Recreated whole. The signature changes, so the old one is dropped first
-- rather than left as an overload PostgREST would have to choose between.
--
-- Arrays follow the same rule as the text: null leaves them, and an empty array
-- clears them. A form that posts only what it renders must not blank what it
-- did not.
-- -----------------------------------------------------------------------------

drop function if exists public.update_marketplace(
  uuid, boolean, boolean, text, text, text, text, date, text, text, text, numeric, numeric, text
);

create function public.update_marketplace(
  p_company_id        uuid,
  p_sells             boolean default null,
  p_sources           boolean default null,
  p_store_name        text    default null,
  p_seller_account_id text    default null,
  p_store_url         text    default null,
  p_account_status    text    default null,
  p_opened_on         date    default null,
  p_settlement_terms  text    default null,
  p_payout_method     text    default null,
  p_payout_currency   text    default null,
  p_reserve_percent   numeric default null,
  p_minimum_lot_value numeric default null,
  p_notes             text    default null,
  p_fee_notes         text    default null,
  p_marketplace_type  text[]  default null,
  p_fulfilment        text[]  default null,
  p_payment           text    default null,
  p_buyers_premium    boolean default null,
  p_selling_cost      text    default null,
  p_audience          text[]  default null,
  p_inventory_type    text[]  default null,
  p_priority          text    default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.current_org_id();
  v_row public.marketplace_profiles%rowtype;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow changing records';
  end if;

  select * into v_row from public.marketplace_profiles
  where company_id = p_company_id and organization_id = v_org
  for update;

  if not found then
    raise exception 'Marketplace not found';
  end if;

  if coalesce(p_sells, v_row.sells_through) is false
     and coalesce(p_sources, v_row.sources_from) is false then
    raise exception 'A marketplace has to be one you sell through, source from, or both';
  end if;

  update public.marketplace_profiles set
    sells_through     = coalesce(p_sells, v_row.sells_through),
    sources_from      = coalesce(p_sources, v_row.sources_from),
    store_name        = public.blank_or(p_store_name, v_row.store_name),
    seller_account_id = public.blank_or(p_seller_account_id, v_row.seller_account_id),
    store_url         = public.blank_or(p_store_url, v_row.store_url),
    account_status    = public.blank_or(p_account_status, v_row.account_status),
    opened_on         = coalesce(p_opened_on, v_row.opened_on),
    settlement_terms  = public.blank_or(p_settlement_terms, v_row.settlement_terms),
    payout_method     = public.blank_or(p_payout_method, v_row.payout_method),
    payout_currency   = upper(public.blank_or(p_payout_currency, v_row.payout_currency)),
    reserve_percent   = coalesce(p_reserve_percent, v_row.reserve_percent),
    minimum_lot_value = coalesce(p_minimum_lot_value, v_row.minimum_lot_value),
    notes             = public.blank_or(p_notes, v_row.notes),

    fee_notes         = public.blank_or(p_fee_notes, v_row.fee_notes),
    marketplace_type  = coalesce(p_marketplace_type, v_row.marketplace_type),
    fulfilment        = coalesce(p_fulfilment, v_row.fulfilment),
    payment           = public.blank_or(p_payment, v_row.payment),
    /*
     * The one field where null cannot mean "leave it", because null is also a
     * real answer — nobody has said. The form always posts it, as true, false
     * or the empty string, and the empty string is what reaches here as null.
     */
    buyers_premium    = p_buyers_premium,
    selling_cost      = public.blank_or(p_selling_cost, v_row.selling_cost),
    audience          = coalesce(p_audience, v_row.audience),
    inventory_type    = coalesce(p_inventory_type, v_row.inventory_type),
    priority          = public.blank_or(p_priority, v_row.priority)
  where company_id = p_company_id;
end;
$$;

revoke execute on function public.update_marketplace(
  uuid, boolean, boolean, text, text, text, text, date, text, text, text, numeric, numeric,
  text, text, text[], text[], text, boolean, text, text[], text[], text
) from public, anon;

grant execute on function public.update_marketplace(
  uuid, boolean, boolean, text, text, text, text, date, text, text, text, numeric, numeric,
  text, text, text[], text[], text, boolean, text, text[], text[], text
) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The two that mirror
--
-- Sells in is not stored here. companies.sells_in already holds it, already
-- normalises to sorted ISO codes through the trigger in 20260238000000, and is
-- already what the territory filters read. A second copy on the profile would
-- be a second thing to keep true, and the first time they disagreed nobody
-- would know which was right.
--
-- Priority has no company column to mirror — priority is a contact field. So it
-- is stored on the profile and drawn from the same option list contacts use,
-- which is what makes "Critical" mean one thing across the CRM. If companies
-- should carry a priority of their own, that is a separate change and this
-- column should follow it rather than the other way round.
-- -----------------------------------------------------------------------------
