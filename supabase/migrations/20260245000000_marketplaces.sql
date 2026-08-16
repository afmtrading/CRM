-- =============================================================================
-- Marketplaces
--
-- A marketplace is a company with an extra profile, not a new kind of record.
--
-- WHY NOT ITS OWN TABLE
--
-- Everything in this schema keys on entity type — activities, tags, notes,
-- saved filters, custom fields, field options, duplicates, import, bulk edit,
-- bulk delete, hidden records, column preferences, permission sets. A third
-- entity means touching all of it, and then a marketplace's deals, orders and
-- invoices would need parallel plumbing on top. Sixty of the two hundred
-- companies in the first real import are already marketplaces, auction
-- platforms or directories: the data is in companies and belongs there.
--
-- WHY NOT A FLAG
--
-- Because of the seven records in that same import tagged "Auctioneer & Buyer".
-- A firm can run a platform you sell through *and* buy pallets from you
-- directly. A boolean forces a choice; a separate table forces two records with
-- two sets of contacts and two activity histories. A profile on top of a
-- company is neither: one record, in both sections, with one history.
--
-- WHAT IS DIFFERENT ABOUT ONE
--
-- Not the fields — the question. Of a buyer you ask whether they will buy and
-- how credible they are. Of a marketplace you ask what it costs to trade there
-- and what you keep. That is what these two tables answer and companies cannot.
-- =============================================================================

create table if not exists public.marketplace_profiles (
  /*
   * The company *is* the marketplace, so its id is the key. No surrogate: a
   * second identifier would let two profiles exist for one company, which is
   * not a state with a meaning.
   */
  company_id        uuid primary key references public.companies (id) on delete cascade,
  organization_id   uuid not null references public.organizations (id) on delete cascade,

  /*
   * Both directions, because both happen. AFM lists inventory on some of these
   * and buys pallets through others, and a few are both. Two booleans rather
   * than one direction column: "either" is a real answer, and an enum would
   * need a third value meaning "both" that every reader has to remember.
   */
  sells_through     boolean not null default true,
  sources_from      boolean not null default false,

  -- The account, as the platform knows it
  store_name        text,
  seller_account_id text,
  store_url         text,
  /** Drawn from field_options like every other select field. */
  account_status    text,
  opened_on         date,

  -- Getting paid
  /** "Weekly", "Net 30" — an organization's own words, so text. */
  settlement_terms  text,
  payout_method     text,
  /** What they settle in, which need not be what the organization reports in. */
  payout_currency   text,
  /** Held back against returns, as a percentage of a payout. */
  reserve_percent   numeric(6, 3) check (reserve_percent is null or (reserve_percent >= 0 and reserve_percent <= 100)),

  -- What they will take
  minimum_lot_value numeric(14, 2) check (minimum_lot_value is null or minimum_lot_value >= 0),
  notes             text,

  created_by        uuid references public.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.marketplace_profiles is
  'What makes a company a marketplace. Its presence is the answer to "is this one" — adding a row promotes, removing it demotes, and the company survives either way.';
comment on column public.marketplace_profiles.sells_through is
  'AFM lists inventory here. Both this and sources_from can be true — an auctioneer who also buys is one company, not two.';

create index if not exists marketplace_profiles_org_idx
  on public.marketplace_profiles (organization_id);

-- -----------------------------------------------------------------------------
-- What it costs to trade there
--
-- Its own table because the rates are per category, and per-category rates on
-- the profile would be either a jsonb blob nobody can total or a column per
-- category that a new category invalidates.
--
-- The category is a product_category value — the organization's own list, the
-- same one products are filed under. That is what makes the arithmetic real: a
-- product knows its category, so it knows its rate. A separate marketplace
-- vocabulary would have to be mapped to the product one by hand, and would be
-- wrong the first time somebody renamed a category on one side only.
-- -----------------------------------------------------------------------------

create table if not exists public.marketplace_fees (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  marketplace_id     uuid not null references public.marketplace_profiles (company_id) on delete cascade,

  /** A product_category value, or null for everything without a rate of its own. */
  category           text,

  /*
   * Which way the money runs. Selling, the platform takes a cut of what the
   * buyer pays; buying, it adds a premium to what was bid. Same table because
   * the shape is identical and the arithmetic differs only in sign — and
   * because an auction house charges both, so one marketplace has rows of each.
   */
  side               text not null check (side in ('sell', 'buy')),

  /** Commission, or the buyer's premium. Percent of the gross. */
  percent            numeric(6, 3) not null default 0
                       check (percent >= 0 and percent <= 100),
  /** Listing or lot fee, charged whatever the amount. */
  fixed_fee          numeric(14, 2) not null default 0 check (fixed_fee >= 0),
  /** Card or settlement handling, separate because it is charged separately. */
  processing_percent numeric(6, 3) not null default 0
                       check (processing_percent >= 0 and processing_percent <= 100),

  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

/*
 * `nulls not distinct` is what makes "no category" one row rather than an
 * infinity of them — the same reason stock_levels uses it for "no bin". Without
 * it every save would add another default row for the same side.
 */
create unique index if not exists marketplace_fees_rate_idx
  on public.marketplace_fees (marketplace_id, side, category) nulls not distinct;

create index if not exists marketplace_fees_org_idx
  on public.marketplace_fees (organization_id);

comment on table public.marketplace_fees is
  'Per-category rates, per direction. A row with a null category is the fallback for anything without one of its own.';

drop trigger if exists marketplace_profiles_updated_at on public.marketplace_profiles;
create trigger marketplace_profiles_updated_at
  before update on public.marketplace_profiles
  for each row execute function public.set_updated_at();

drop trigger if exists marketplace_fees_updated_at on public.marketplace_fees;
create trigger marketplace_fees_updated_at
  before update on public.marketplace_fees
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Who sees one
--
-- Exactly who sees the company. A marketplace profile is an attribute of a
-- company, so inventing its own visibility rule would mean a company somebody
-- cannot see whose fee structure they can — or the reverse, which is worse. The
-- policies below say "you can see the profile if you can see the company", by
-- asking the companies table through its own policies.
-- -----------------------------------------------------------------------------

alter table public.marketplace_profiles enable row level security;
alter table public.marketplace_profiles force row level security;
alter table public.marketplace_fees enable row level security;
alter table public.marketplace_fees force row level security;

drop policy if exists marketplace_profiles_select on public.marketplace_profiles;
create policy marketplace_profiles_select on public.marketplace_profiles
  for select to authenticated
  using (
    organization_id = (select public.current_org_id())
    and exists (select 1 from public.companies c where c.id = company_id)
  );

drop policy if exists marketplace_fees_select on public.marketplace_fees;
create policy marketplace_fees_select on public.marketplace_fees
  for select to authenticated
  using (
    organization_id = (select public.current_org_id())
    and exists (
      select 1 from public.marketplace_profiles p where p.company_id = marketplace_id
    )
  );

/*
 * Select only. Every write goes through one of the functions below — the same
 * one-door pattern stock_levels uses — so the checks cannot be skipped by
 * posting straight at the table, and a fee row can never point at a company
 * that is not a marketplace.
 */
grant select on public.marketplace_profiles to authenticated;
grant select on public.marketplace_fees to authenticated;

-- -----------------------------------------------------------------------------
-- Becoming one, and stopping
-- -----------------------------------------------------------------------------

create or replace function public.add_marketplace(
  p_company_id uuid,
  p_sells      boolean default true,
  p_sources    boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow changing records';
  end if;

  -- Definer, so the company's own policies are not consulted. Hidden is checked
  -- by hand for the same reason it is on delete: promoting a record you cannot
  -- see would tell you it exists.
  if not exists (
    select 1 from public.companies
    where id = p_company_id
      and organization_id = v_org
      and deleted_at is null
      and (hidden is false or public.can_see_hidden())
  ) then
    raise exception 'Company not found';
  end if;

  if not (coalesce(p_sells, false) or coalesce(p_sources, false)) then
    raise exception 'A marketplace has to be one you sell through, source from, or both';
  end if;

  insert into public.marketplace_profiles (
    company_id, organization_id, sells_through, sources_from, created_by
  )
  values (
    p_company_id, v_org, coalesce(p_sells, true), coalesce(p_sources, false),
    public.current_app_user_id()
  )
  on conflict (company_id) do update
    set sells_through = excluded.sells_through,
        sources_from  = excluded.sources_from;

  return p_company_id;
end;
$$;

comment on function public.add_marketplace(uuid, boolean, boolean) is
  'Promotes a company to a marketplace, or updates which directions it trades in. Idempotent: pressing it twice is not two marketplaces.';

/**
 * Demotes it back to an ordinary company.
 *
 * The fees go with it, by cascade, and that is the honest behaviour: a rate
 * card for a channel nobody uses is not history worth keeping, and leaving
 * orphaned rows would make re-promoting it silently restore stale rates. The
 * company, its contacts, its orders and its whole activity history are
 * untouched — which is the point of the profile being separable.
 */
create or replace function public.remove_marketplace(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow changing records';
  end if;

  delete from public.marketplace_profiles
  where company_id = p_company_id and organization_id = v_org;
end;
$$;

-- -----------------------------------------------------------------------------
-- Editing the profile
--
-- One function taking every field, with null meaning "leave it alone" — the
-- rule set_stock_level already follows. A form that posts only what it renders
-- must not blank what it did not.
-- -----------------------------------------------------------------------------

create or replace function public.update_marketplace(
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
  p_notes             text    default null
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

  /*
   * Text fields take the same null-leaves-it, empty-clears-it rule as the
   * numbers. `blank()` below is that rule written once rather than thirteen
   * times, and it is what makes an emptied box different from an untouched one.
   */
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
    notes             = public.blank_or(p_notes, v_row.notes)
  where company_id = p_company_id;
end;
$$;

/**
 * null leaves the old value, '' clears it, anything else replaces it.
 *
 * The rule the rest of this schema already follows, in one place. Written as a
 * function rather than repeated inline because thirteen copies of a coalesce
 * and a nullif is thirteen chances to get one of them backwards.
 */
create or replace function public.blank_or(p_new text, p_old text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_new is null then p_old else nullif(btrim(p_new), '') end;
$$;

-- -----------------------------------------------------------------------------
-- The rate card
-- -----------------------------------------------------------------------------

create or replace function public.set_marketplace_fee(
  p_marketplace_id     uuid,
  p_side               text,
  p_category           text default null,
  p_percent            numeric default 0,
  p_fixed_fee          numeric default 0,
  p_processing_percent numeric default 0,
  p_note               text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org      uuid := public.current_org_id();
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
  v_id       uuid;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow changing records';
  end if;

  if p_side not in ('sell', 'buy') then
    raise exception 'A fee is charged on selling or on buying, not on %', p_side;
  end if;

  if not exists (
    select 1 from public.marketplace_profiles
    where company_id = p_marketplace_id and organization_id = v_org
  ) then
    raise exception 'Marketplace not found';
  end if;

  /*
   * The category has to be one of this organization's own product categories,
   * or nothing. Free text here would let "Medical" and "medical " become two
   * rate rows for one category, and the product that has to match one of them
   * would find neither.
   */
  if v_category is not null and not exists (
    select 1 from public.field_options
    where organization_id = v_org
      and entity_type = 'product'
      and field_key = 'product_category'
      and value = v_category
  ) then
    raise exception 'No product category called %', v_category;
  end if;

  insert into public.marketplace_fees (
    organization_id, marketplace_id, category, side,
    percent, fixed_fee, processing_percent, note
  )
  values (
    v_org, p_marketplace_id, v_category, p_side,
    coalesce(p_percent, 0), coalesce(p_fixed_fee, 0), coalesce(p_processing_percent, 0),
    nullif(btrim(coalesce(p_note, '')), '')
  )
  on conflict (marketplace_id, side, category) do update
    set percent            = excluded.percent,
        fixed_fee          = excluded.fixed_fee,
        processing_percent = excluded.processing_percent,
        note               = excluded.note
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.set_marketplace_fee(uuid, text, text, numeric, numeric, numeric, text) is
  'Sets one rate. A null category is the fallback for anything without a rate of its own.';

create or replace function public.remove_marketplace_fee(p_fee_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow changing records';
  end if;

  delete from public.marketplace_fees
  where id = p_fee_id and organization_id = public.current_org_id();
end;
$$;

revoke execute on function public.add_marketplace(uuid, boolean, boolean) from public, anon;
revoke execute on function public.remove_marketplace(uuid) from public, anon;
revoke execute on function public.update_marketplace(uuid, boolean, boolean, text, text, text, text, date, text, text, text, numeric, numeric, text) from public, anon;
revoke execute on function public.set_marketplace_fee(uuid, text, text, numeric, numeric, numeric, text) from public, anon;
revoke execute on function public.remove_marketplace_fee(uuid) from public, anon;
revoke execute on function public.blank_or(text, text) from public, anon;

grant execute on function public.add_marketplace(uuid, boolean, boolean) to authenticated, service_role;
grant execute on function public.remove_marketplace(uuid) to authenticated, service_role;
grant execute on function public.update_marketplace(uuid, boolean, boolean, text, text, text, text, date, text, text, text, numeric, numeric, text) to authenticated, service_role;
grant execute on function public.set_marketplace_fee(uuid, text, text, numeric, numeric, numeric, text) to authenticated, service_role;
grant execute on function public.remove_marketplace_fee(uuid) to authenticated, service_role;
grant execute on function public.blank_or(text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The vocabulary a marketplace needs
--
-- Account status is a select field like every other one, so it goes in
-- field_options where an organization can edit it without a deployment. Seeded
-- with the four states an account is actually in, which is more use than an
-- empty list somebody has to invent from scratch.
-- -----------------------------------------------------------------------------

insert into public.field_options (organization_id, entity_type, field_key, value, color, "order")
select o.id, 'company', 'marketplace_account_status', v.value, v.color, v.ord
from public.organizations o
cross join (values
  ('Active', 'green', 0),
  ('Onboarding', 'amber', 1),
  ('Paused', 'slate', 2),
  ('Closed', 'red', 3)
) as v(value, color, ord)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- The list a person can arrange
--
-- save_column_preference checks the list name against a whitelist, so the new
-- section has to be added to it or every save from that screen is refused.
-- Recreated whole rather than patched: one line changes, and a function has no
-- ALTER that edits a statement in place.
-- -----------------------------------------------------------------------------

create or replace function public.save_column_preference(
  p_entity  text,
  p_columns text[]
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_org  uuid := public.current_org_id();
  v_user uuid := public.current_app_user_id();
begin
  if v_org is null or v_user is null then
    raise exception 'No signed-in user in context';
  end if;

  if p_entity not in ('contact', 'company', 'product', 'marketplace') then
    raise exception 'There is no % list', p_entity;
  end if;

  if coalesce(array_length(p_columns, 1), 0) > 40 then
    raise exception 'That is too many columns';
  end if;

  insert into public.column_preferences (organization_id, user_id, entity_type, columns)
  values (v_org, v_user, p_entity, coalesce(p_columns, '{}'))
  on conflict (user_id, entity_type)
  do update set columns = excluded.columns;
end;
$$;
