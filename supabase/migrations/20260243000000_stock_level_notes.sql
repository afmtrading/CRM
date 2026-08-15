-- -----------------------------------------------------------------------------
-- A note against a place
--
-- The stock card says how much is in each location and nothing about it. In a
-- liquidation business the "about it" is half the information: which pallet the
-- damaged units are on, that the count is short pending a recount, that a
-- location is a customer's floor rather than a warehouse. That knowledge
-- currently lives in somebody's head or in the product's general notes, where
-- it does not say which shelf it is about.
--
-- Not to be confused with stock_adjustments.note, which already exists and is a
-- different thing: that explains one movement and is fixed the moment it is
-- written, because a historical record that can be edited is not a record. This
-- one describes the place as it stands now and is meant to be revised.
-- -----------------------------------------------------------------------------

alter table public.stock_levels
  add column if not exists note text;

comment on column public.stock_levels.note is
  'Standing note about this product in this place — condition, a recount pending, whose floor it is on. Current state, revisable. For why a number moved, see stock_adjustments.note.';

comment on column public.stock_adjustments.note is
  'Why this one movement happened. Written once and never edited — an editable history is not a history. For a standing note about the place, see stock_levels.note.';

-- -----------------------------------------------------------------------------
-- Writing it
--
-- Dropped and recreated rather than replaced. `create or replace` with an extra
-- argument makes an overload, not a replacement, and two functions differing by
-- one defaulted parameter is exactly the ambiguity PostgREST resolves by
-- guessing. One signature, or none.
--
-- p_note was taken — it is the adjustment's reason — so the new one is
-- p_place_note, and the difference is in the name rather than in a comment
-- somebody has to find.
--
-- null means "leave it alone", which is how p_quantity and p_reserved already
-- behave here. Clearing a note is an empty string, and the function turns that
-- back into null so the column holds one kind of nothing rather than two.
-- -----------------------------------------------------------------------------

drop function if exists public.set_stock_level(uuid, uuid, uuid, numeric, numeric, text, text);

create function public.set_stock_level(
  p_product_id  uuid,
  p_location_id uuid,
  p_bin_id      uuid default null,
  p_quantity    numeric default null,
  p_reserved    numeric default null,
  p_reason      text default null,
  p_note        text default null,
  p_place_note  text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org      uuid := public.current_org_id();
  v_actor    uuid := public.current_app_user_id();
  v_level    stock_levels%rowtype;
  v_quantity numeric;
  v_reserved numeric;
  v_place    text;
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

  if length(coalesce(p_place_note, '')) > 500 then
    raise exception 'That note is too long for a stock line — put it on the product';
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
  v_place    := case
                  when p_place_note is null then v_level.note
                  else nullif(btrim(p_place_note), '')
                end;

  update stock_levels
  set quantity = v_quantity, reserved = v_reserved, note = v_place, updated_by = v_actor
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

  /*
   * Editing the note writes no adjustment, on purpose. stock_adjustments is the
   * ledger the on-hand total is accounted for by — every row in it carries a
   * delta and a quantity_after — and putting a row in it that moved nothing
   * would mean the history no longer reads as a sequence of movements.
   * updated_at and updated_by on the row itself say the note was touched and by
   * whom, which is the right weight for a note.
   */
end;
$$;

comment on function public.set_stock_level(uuid, uuid, uuid, numeric, numeric, text, text, text) is
  'The only way a stock quantity moves. Records the movement as it makes it. p_note explains the movement; p_place_note is the standing note on the place, and null leaves it as it was.';

revoke execute on function
  public.set_stock_level(uuid, uuid, uuid, numeric, numeric, text, text, text)
  from public, anon;
grant execute on function
  public.set_stock_level(uuid, uuid, uuid, numeric, numeric, text, text, text)
  to authenticated, service_role;
