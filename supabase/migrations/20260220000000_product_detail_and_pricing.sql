-- =============================================================================
-- What a product is, and what it costs at every unit it is sold in
--
-- The catalogue was built for commodities: a name, a SKU, a unit, one price and
-- one cost. That is enough to price a container of shea butter and nothing like
-- enough to describe a pallet of retail goods, which has a brand, a model, a
-- colour, a size, a condition, a case pack — and a different price depending on
-- whether you are selling one piece, one unit or the whole pallet.
--
-- Two additions, and one replacement:
--
--   Description   brand, model, count, size, colour, case pack, type,
--                 condition, status and a line of notes.
--
--   Pricing       three price levels (retail, showroom, wholesale) across
--                 three quantities (unit, piece, pallet), plus costs and
--                 links out to what the market is charging.
--
--   Status        replaces the `active` checkbox with a five-value lifecycle.
--                 `active` survives as a derived column so that every picker
--                 and filter already written against it keeps working.
--
-- WHAT IS NOT STORED HERE
--
-- Six of the price columns are nullable on purpose, and null does not mean
-- zero — it means "nobody has said, so work it out". Showroom is 70% of retail
-- and wholesale is 30% until somebody types something else; a piece price is
-- the unit price divided by the case pack. Storing the computed number instead
-- would freeze it: raise retail next quarter and the showroom price would
-- quietly stay where it was, which is the bug this avoids. The rule lives in
-- src/lib/products.ts, is applied everywhere a price is read, and is unit
-- tested there.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- What it is
-- -----------------------------------------------------------------------------
alter table products
  /** The maker. Free text: a brand list would be out of date by Tuesday. */
  add column if not exists brand      text,
  add column if not exists model      text,
  /**
   * How many are in the thing itself — "24 ct", "500 ml", "6-pack". Text, not a
   * number, because half of what arrives is written with its unit attached and
   * splitting it would lose what the seller actually wrote.
   */
  add column if not exists item_count text,
  add column if not exists size       text,
  add column if not exists color      text,
  /**
   * How many pieces are in one unit. A number rather than text, because the
   * piece prices are the unit prices divided by it — see the file header.
   */
  add column if not exists case_pack  integer,
  /** A line of shorthand about this item. Longer prose belongs in description. */
  add column if not exists item_notes text;

-- -----------------------------------------------------------------------------
-- What kind of thing, in what state, and where in its life
--
-- These three are check constraints rather than field_options rows, which is
-- the opposite of how category works. Category is the organization's own
-- vocabulary and nobody else can guess it. These three are not: they are the
-- vocabulary of the trade, they mean the same thing in every warehouse, and
-- status in particular has behaviour hanging off it — see the trigger below.
-- A value the code has to reason about cannot be one an admin can rename.
-- -----------------------------------------------------------------------------
alter table products
  add column if not exists product_type      text,
  add column if not exists product_condition text,
  add column if not exists status            text;

-- Existing rows predate the lifecycle, so they inherit it from the flag they
-- were carrying: anything on offer is active, anything retired is inactive.
update products set status = case when active then 'active' else 'inactive' end
where status is null;

alter table products alter column status set default 'active';
alter table products alter column status set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_product_type_check') then
    alter table products add constraint products_product_type_check
      check (product_type is null
             or product_type in ('item', 'case', 'pallet', 'kit', 'bin'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'products_condition_check') then
    alter table products add constraint products_condition_check
      check (product_condition is null
             or product_condition in ('new', 'open_box', 'damaged', 'refurbished', 'expired'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'products_status_check') then
    alter table products add constraint products_status_check
      check (status in ('active', 'inactive', 'discontinued', 'quarantined', 'sold'));
  end if;

  -- A case of nothing is not a case. Zero would make every piece price a
  -- division by zero, so it is refused at the door rather than guarded at
  -- eleven call sites.
  if not exists (select 1 from pg_constraint where conname = 'products_case_pack_check') then
    alter table products add constraint products_case_pack_check
      check (case_pack is null or case_pack > 0);
  end if;
end
$$;

comment on column products.status is
  'Lifecycle. Only ''active'' is offered on new deals; products.active is kept in step with this and should not be written directly.';

-- -----------------------------------------------------------------------------
-- Keeping `active` honest
--
-- `active` is read in half a dozen places — the products list, the deal line
-- item picker, the headline counts — and rewriting all of them to say
-- `status = 'active'` would be a wide change for no gain. Instead the flag
-- becomes derived: status is what people set, active is what the rest of the
-- app already asks about, and the two can no longer disagree.
--
-- Not a generated column, because those cannot be added to a table that already
-- has a plain column of the same name without dropping it first, and dropping
-- `active` would take every policy and index that mentions it with it.
-- -----------------------------------------------------------------------------
create or replace function public.products_sync_active()
returns trigger
language plpgsql
-- Pinned like every other function in this schema, so nothing it touches can be
-- shadowed by a schema earlier on somebody else's search path.
set search_path = public, pg_temp
as $$
begin
  new.active := (new.status = 'active');
  return new;
end;
$$;

drop trigger if exists products_sync_active on products;
create trigger products_sync_active
  before insert or update of status, active on products
  for each row execute function public.products_sync_active();

-- -----------------------------------------------------------------------------
-- What it costs
--
-- The two columns that were already here keep their names and change their
-- meaning not at all: unit_price is Unit $: Retail — the price a deal line item
-- copies when the product is added to it — and unit_cost is Unit $: Cost. Only
-- the labels in the app changed, so no closed deal is re-priced by this
-- migration.
--
-- Everything added here is nullable. Null in a price column means "derive it";
-- null in a cost column means nobody has costed it at that quantity, and no
-- rule can invent one.
-- -----------------------------------------------------------------------------
alter table products
  -- Auto 70% and 30% of retail respectively, until overridden.
  add column if not exists price_showroom        numeric(14, 2),
  add column if not exists price_wholesale       numeric(14, 2),
  -- Auto: the matching unit price ÷ case pack.
  add column if not exists piece_price_retail    numeric(14, 2),
  add column if not exists piece_price_showroom  numeric(14, 2),
  add column if not exists piece_price_wholesale numeric(14, 2),
  -- No rule to derive these from: a pallet is priced by negotiation.
  add column if not exists pallet_price_retail   numeric(14, 2),
  add column if not exists pallet_price_wholesale numeric(14, 2),
  add column if not exists piece_cost            numeric(14, 2),
  add column if not exists pallet_cost           numeric(14, 2);

-- One constraint over all nine rather than nine constraints: they say the same
-- thing, and a negative price is a typo whichever box it was typed into.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_extra_prices_check') then
    alter table products add constraint products_extra_prices_check check (
      coalesce(price_showroom, 0)         >= 0 and
      coalesce(price_wholesale, 0)        >= 0 and
      coalesce(piece_price_retail, 0)     >= 0 and
      coalesce(piece_price_showroom, 0)   >= 0 and
      coalesce(piece_price_wholesale, 0)  >= 0 and
      coalesce(pallet_price_retail, 0)    >= 0 and
      coalesce(pallet_price_wholesale, 0) >= 0 and
      coalesce(piece_cost, 0)             >= 0 and
      coalesce(pallet_cost, 0)            >= 0
    );
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- What the market is charging
--
-- Three links out. Stored as typed and rendered through safeUrl(), which is the
-- same treatment every other user-supplied link in the app gets: validating the
-- scheme on the way in would reject a bare domain somebody pasted from a
-- browser bar, and validating on the way out is what actually keeps a
-- `javascript:` URL out of an href.
-- -----------------------------------------------------------------------------
alter table products
  add column if not exists barcode_url text,
  add column if not exists comp_1_url  text,
  add column if not exists comp_2_url  text;

-- The list page filters on status the moment there is more than one value in
-- play, and the picker filters on the flag derived from it.
create index if not exists products_status_idx
  on products (organization_id, status) where deleted_at is null;

-- Brand is the second thing anybody searches for after name.
create index if not exists products_brand_idx
  on products (organization_id, lower(brand)) where brand is not null;
