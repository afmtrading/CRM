-- =============================================================================
-- Stock
--
-- The catalogue says what a product is and what it costs. It has never said
-- whether there are any. A trading company's first question about a pallet is
-- "how many, and where", and until now the answer lived in somebody's
-- spreadsheet.
--
-- Four tables:
--
--   stock_locations    warehouses. Org-wide reference data, like pipelines.
--   stock_bins         a shelf, a rack, an aisle — optional, inside a location.
--   stock_levels       how many of a product are in one place. The only
--                      mutable number in here.
--   stock_adjustments  every change to that number, and who made it.
--
-- THE ONE DOOR
--
-- stock_levels is not writable by anybody. `authenticated` is granted SELECT
-- and nothing else, and every change goes through set_stock_level(), which
-- writes the level and its adjustment in the same statement. That is the whole
-- reason the history can be trusted: there is no path that changes a quantity
-- without recording that it changed. A trigger could log the change but not why
-- it was made, and "why" is most of what an inventory history is for.
--
-- THE FOUR NUMBERS
--
--   On hand    what is physically there. Summed across locations.
--   Committed  what open deals have already promised. Not stored — it is read
--              off the deal line items, because a second copy of a number the
--              deals already know would start disagreeing with them the first
--              time anybody edited a deal.
--   Reserved   held back by hand, for a reason that is not a deal yet.
--   Available  on hand less committed less reserved. Can go negative, and is
--              shown negative rather than clamped: overselling is a fact worth
--              seeing, not one worth hiding behind a zero.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Where stock lives
-- -----------------------------------------------------------------------------
create table if not exists stock_locations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name            text not null,
  /** A short label for tables and pickers — "TOR", "MTL-3". */
  code            text,
  address         text,
  /** Retired but still holding history. The alternative to deleting. */
  active          boolean not null default true,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists stock_locations_org_name_idx
  on stock_locations (organization_id, lower(name));
create index if not exists stock_locations_live_idx
  on stock_locations (organization_id) where active;

create trigger stock_locations_updated_at
  before update on stock_locations
  for each row execute function set_updated_at();

create table if not exists stock_bins (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  location_id     uuid not null references stock_locations (id) on delete cascade,
  name            text not null,
  created_at      timestamptz not null default now()
);

create unique index if not exists stock_bins_location_name_idx
  on stock_bins (location_id, lower(name));

-- -----------------------------------------------------------------------------
-- How many, and where
--
-- One row per product per place. numeric rather than integer because half a
-- tonne of shea butter is a real quantity, and deal_products already counts in
-- the same units.
-- -----------------------------------------------------------------------------
create table if not exists stock_levels (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  product_id      uuid not null references products (id) on delete cascade,
  -- restrict, not cascade: deleting a warehouse must never silently destroy the
  -- count of what was in it. Retire the location instead.
  location_id     uuid not null references stock_locations (id) on delete restrict,
  bin_id          uuid references stock_bins (id) on delete set null,
  quantity        numeric(14, 3) not null default 0 check (quantity >= 0),
  /** Held back by hand. Never exceeds what is on hand. */
  reserved        numeric(14, 3) not null default 0 check (reserved >= 0),
  updated_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- `nulls not distinct` is what makes "no bin" a place rather than an infinity of
-- them. Without it every save would add another binless row for the same shelf.
create unique index if not exists stock_levels_place_idx
  on stock_levels (product_id, location_id, bin_id) nulls not distinct;

create index if not exists stock_levels_product_idx on stock_levels (organization_id, product_id);
create index if not exists stock_levels_location_idx on stock_levels (organization_id, location_id);

create trigger stock_levels_updated_at
  before update on stock_levels
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- What changed, when, and why
--
-- Append-only. Nothing updates or deletes a row here, which is the point: a
-- history somebody can edit is not a history. The columns record the movement
-- rather than the resulting state, and carry the resulting state beside it so a
-- reader never has to replay the whole table to know where things stood.
-- -----------------------------------------------------------------------------
create table if not exists stock_adjustments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  product_id      uuid not null references products (id) on delete cascade,
  -- Nullable and set null: the history outlives the warehouse it happened in.
  location_id     uuid references stock_locations (id) on delete set null,
  bin_id          uuid references stock_bins (id) on delete set null,
  /** Which number moved. */
  field           text not null check (field in ('quantity', 'reserved')),
  delta           numeric(14, 3) not null,
  quantity_after  numeric(14, 3) not null,
  /** Why, in the organization's own words. */
  reason          text,
  note            text,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists stock_adjustments_product_idx
  on stock_adjustments (organization_id, product_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Grants
--
-- Note what is missing: stock_levels and stock_adjustments get SELECT and
-- nothing else. Every write goes through set_stock_level().
-- -----------------------------------------------------------------------------
revoke all on stock_locations from anon;
revoke all on stock_bins from anon;
revoke all on stock_levels from anon;
revoke all on stock_adjustments from anon;

grant select, insert, update, delete on stock_locations to authenticated;
grant select, insert, update, delete on stock_bins to authenticated;
grant select on stock_levels to authenticated;
grant select on stock_adjustments to authenticated;

alter table stock_locations enable row level security;
alter table stock_locations force row level security;
alter table stock_bins enable row level security;
alter table stock_bins force row level security;
alter table stock_levels enable row level security;
alter table stock_levels force row level security;
alter table stock_adjustments enable row level security;
alter table stock_adjustments force row level security;

-- Warehouses are shared reference data, like the catalogue: everyone reads,
-- managers change.
drop policy if exists stock_locations_select on stock_locations;
create policy stock_locations_select on stock_locations
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists stock_locations_write on stock_locations;
create policy stock_locations_write on stock_locations
  for all to authenticated
  using (organization_id = public.current_org_id() and public.can_manage_records())
  with check (organization_id = public.current_org_id() and public.can_manage_records());

drop policy if exists stock_bins_select on stock_bins;
create policy stock_bins_select on stock_bins
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists stock_bins_write on stock_bins;
create policy stock_bins_write on stock_bins
  for all to authenticated
  using (organization_id = public.current_org_id() and public.can_manage_records())
  with check (organization_id = public.current_org_id() and public.can_manage_records());

drop policy if exists stock_levels_select on stock_levels;
create policy stock_levels_select on stock_levels
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists stock_adjustments_select on stock_adjustments;
create policy stock_adjustments_select on stock_adjustments
  for select to authenticated
  using (organization_id = public.current_org_id());

-- -----------------------------------------------------------------------------
-- The only way a quantity changes
--
-- Null means "leave this one alone", so setting the count without touching what
-- is reserved does not require knowing what was reserved.
--
-- can_write_records rather than can_manage_records: counting stock is what
-- warehouse work is, and requiring a manager for it would either stop the count
-- happening or get a manager's password shared. Every movement is attributed
-- and permanent, which is the control that actually matters here — the
-- catalogue's prices stay a manager's business.
-- -----------------------------------------------------------------------------
create or replace function public.set_stock_level(
  p_product_id  uuid,
  p_location_id uuid,
  p_bin_id      uuid default null,
  p_quantity    numeric default null,
  p_reserved    numeric default null,
  p_reason      text default null,
  p_note        text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org        uuid := public.current_org_id();
  v_actor      uuid := public.current_app_user_id();
  v_level      stock_levels%rowtype;
  v_quantity   numeric;
  v_reserved   numeric;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow changing stock';
  end if;

  if p_quantity is not null and p_quantity < 0 then
    raise exception 'A quantity cannot be negative';
  end if;
  if p_reserved is not null and p_reserved < 0 then
    raise exception 'A reserved quantity cannot be negative';
  end if;

  -- Definer, so none of the three tables' policies are doing the checking.
  -- Every one of them is re-checked here by hand.
  if not exists (
    select 1 from products
    where id = p_product_id and organization_id = v_org and deleted_at is null
  ) then
    raise exception 'Product not found';
  end if;

  if not exists (
    select 1 from stock_locations where id = p_location_id and organization_id = v_org
  ) then
    raise exception 'Location not found';
  end if;

  if p_bin_id is not null and not exists (
    select 1 from stock_bins
    where id = p_bin_id and organization_id = v_org and location_id = p_location_id
  ) then
    raise exception 'That bin is not in that location';
  end if;

  select * into v_level from stock_levels
  where product_id = p_product_id
    and location_id = p_location_id
    and bin_id is not distinct from p_bin_id
  for update;

  if not found then
    insert into stock_levels (organization_id, product_id, location_id, bin_id, updated_by)
    values (v_org, p_product_id, p_location_id, p_bin_id, v_actor)
    returning * into v_level;
  end if;

  v_quantity := coalesce(p_quantity, v_level.quantity);
  v_reserved := coalesce(p_reserved, v_level.reserved);

  update stock_levels
  set quantity = v_quantity, reserved = v_reserved, updated_by = v_actor
  where id = v_level.id;

  -- A save that changed nothing is not an adjustment. Writing one anyway would
  -- fill the history with rows that say a number stayed the same.
  if v_quantity <> v_level.quantity then
    insert into stock_adjustments (
      organization_id, product_id, location_id, bin_id,
      field, delta, quantity_after, reason, note, created_by
    ) values (
      v_org, p_product_id, p_location_id, p_bin_id,
      'quantity', v_quantity - v_level.quantity, v_quantity, p_reason, p_note, v_actor
    );
  end if;

  if v_reserved <> v_level.reserved then
    insert into stock_adjustments (
      organization_id, product_id, location_id, bin_id,
      field, delta, quantity_after, reason, note, created_by
    ) values (
      v_org, p_product_id, p_location_id, p_bin_id,
      'reserved', v_reserved - v_level.reserved, v_reserved, p_reason, p_note, v_actor
    );
  end if;
end;
$$;

/**
 * Stops stocking a product in one place.
 *
 * The row goes; the history stays. Recorded as a movement down to zero rather
 * than as a silent disappearance, so the total that changed can still be
 * accounted for afterwards.
 */
create or replace function public.clear_stock_level(
  p_product_id  uuid,
  p_location_id uuid,
  p_bin_id      uuid default null,
  p_reason      text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   uuid := public.current_org_id();
  v_level stock_levels%rowtype;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow changing stock';
  end if;

  select * into v_level from stock_levels
  where product_id = p_product_id
    and location_id = p_location_id
    and bin_id is not distinct from p_bin_id
    and organization_id = v_org
  for update;

  if not found then
    return;
  end if;

  perform public.set_stock_level(
    p_product_id, p_location_id, p_bin_id, 0, 0,
    coalesce(p_reason, 'Removed from this location'), null
  );

  delete from stock_levels where id = v_level.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- The four numbers
--
-- Definer, and scoped to the organization rather than to what the caller can
-- see. Committed comes from deal line items, and deal_products is visible only
-- for deals the caller owns — so an invoker function would tell a sales rep
-- that 4 units are committed when 40 are, which is worse than telling them
-- nothing. How much of the warehouse is spoken for is not a fact about whose
-- deal it is.
-- -----------------------------------------------------------------------------
create or replace function public.product_stock_summary(p_product_id uuid)
returns table (on_hand numeric, committed numeric, reserved numeric, available numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org       uuid := public.current_org_id();
  v_on_hand   numeric;
  v_reserved  numeric;
  v_committed numeric;
begin
  if not exists (
    select 1 from products
    where id = p_product_id and (v_org is null or organization_id = v_org)
  ) then
    raise exception 'Product not found';
  end if;

  select coalesce(sum(l.quantity), 0), coalesce(sum(l.reserved), 0)
  into v_on_hand, v_reserved
  from stock_levels l
  where l.product_id = p_product_id;

  select coalesce(sum(dp.quantity), 0)
  into v_committed
  from deal_products dp
  join deals d on d.id = dp.deal_id
  -- No deleted_at test: deals are not soft-deleted in this schema, so an open
  -- deal is simply an open deal.
  where dp.product_id = p_product_id
    and d.status = 'open';

  return query select
    v_on_hand,
    v_committed,
    v_reserved,
    -- Deliberately not greatest(0, …): a negative available number means more
    -- has been promised than exists, which is the single most useful thing this
    -- function can tell anybody.
    v_on_hand - v_committed - v_reserved;
end;
$$;

revoke execute on function public.set_stock_level(uuid, uuid, uuid, numeric, numeric, text, text)
  from public, anon;
revoke execute on function public.clear_stock_level(uuid, uuid, uuid, text) from public, anon;
revoke execute on function public.product_stock_summary(uuid) from public, anon;

grant execute on function public.set_stock_level(uuid, uuid, uuid, numeric, numeric, text, text)
  to authenticated, service_role;
grant execute on function public.clear_stock_level(uuid, uuid, uuid, text)
  to authenticated, service_role;
grant execute on function public.product_stock_summary(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Somewhere to put it
--
-- An organization with no warehouse cannot record stock at all, and the first
-- thing everybody would do is create one called "Warehouse". So it already
-- exists, and can be renamed.
-- -----------------------------------------------------------------------------
insert into stock_locations (organization_id, name, code)
select id, 'Main Warehouse', 'MAIN' from organizations
on conflict do nothing;

create or replace function public.organizations_seed_stock_location()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.stock_locations (organization_id, name, code)
  values (new.id, 'Main Warehouse', 'MAIN')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists organizations_seed_stock_location on organizations;
create trigger organizations_seed_stock_location
  after insert on organizations
  for each row execute function public.organizations_seed_stock_location();
