-- =============================================================================
-- A note against a place.
--
--   Two notes now exist and they are not the same thing. stock_adjustments.note
--   explains one movement and is history, so it is written once. stock_levels
--   .note describes the place as it stands and is meant to be revised.
--
--   What is held here is mostly the difference between them: editing a note
--   moves no stock and writes no adjustment, so the ledger keeps reading as a
--   sequence of movements. And the ordinary null-means-leave-it-alone rule the
--   quantity arguments already follow, because an emptied box and an untouched
--   one must not look the same.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

create table fixture (key text primary key, id uuid);
grant select, insert on fixture to authenticated;

create or replace function test_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not p_condition then
    raise exception 'TEST FAILED: %', p_message;
  end if;
  raise notice '  ok: %', p_message;
end;
$$;

grant execute on function test_assert(boolean, text) to authenticated;

create or replace function sign_in_as(p_key text)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', (select id from fixture where key = p_key), 'role', 'authenticated')::text,
    true
  );
end;
$$;

grant execute on function sign_in_as(text) to authenticated;

/** The note on a place, read past every policy. */
create or replace function place_note(p_product uuid, p_location uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select note from stock_levels
  where product_id = p_product and location_id = p_location and bin_id is null;
$$;

create or replace function adjustment_count(p_product uuid)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from stock_adjustments where product_id = p_product;
$$;

grant execute on function place_note(uuid, uuid) to authenticated;
grant execute on function adjustment_count(uuid) to authenticated;

do $$
declare
  v_org     uuid;
  v_admin_a uuid := gen_random_uuid();
  v_ro_a    uuid := gen_random_uuid();
  v_admin   uuid;
  v_ro      uuid;
  v_product uuid;
  v_place   uuid;
begin
  insert into organizations (name, slug) values ('Shelf Co', 'shelf-co') returning id into v_org;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@shelf.test'),
    (v_ro_a, 'ro@shelf.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@shelf.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'ro@shelf.test', 'Ola', 'readonly', v_ro_a, 'active') returning id into v_ro;

  insert into products (organization_id, name, unit_price)
  values (v_org, 'Pallet of speakers', 100) returning id into v_product;

  -- Every organization is seeded one, so this is the one already there.
  select id into v_place from stock_locations where organization_id = v_org limit 1;

  insert into fixture values
    ('org', v_org), ('admin_auth', v_admin_a), ('ro_auth', v_ro_a),
    ('admin', v_admin), ('product', v_product), ('place', v_place);
end;
$$;

set local role authenticated;

-- =============================================================================
-- Setting one, and changing it.
-- =============================================================================
do $$
declare
  v_product uuid := (select id from fixture where key = 'product');
  v_place   uuid := (select id from fixture where key = 'place');
begin
  raise notice 'Writing a note:';
  perform sign_in_as('admin_auth');

  perform public.set_stock_level(v_product, v_place, null, 10, 3, 'Counted', null,
                                 'Two pallets, one shrink-wrapped');
  perform test_assert(
    place_note(v_product, v_place) = 'Two pallets, one shrink-wrapped',
    'a note is stored against the place'
  );

  perform public.set_stock_level(v_product, v_place, null, null, null, null, null,
                                 'Recount pending — pallet 2 opened');
  perform test_assert(
    place_note(v_product, v_place) = 'Recount pending — pallet 2 opened',
    'and it can be rewritten, unlike an adjustment'
  );

  perform test_assert(
    (select quantity from stock_levels where product_id = v_product) = 10,
    'rewriting it moved no stock'
  );
end;
$$;

-- =============================================================================
-- Nothing, and emptiness, are different instructions.
--
-- The quantity arguments already work this way: null leaves the number alone.
-- A note has to follow the same rule or an unrelated save would wipe it — and
-- an emptied box has to actually empty it.
-- =============================================================================
do $$
declare
  v_product uuid := (select id from fixture where key = 'product');
  v_place   uuid := (select id from fixture where key = 'place');
begin
  raise notice 'Null against empty:';
  perform sign_in_as('admin_auth');

  -- An ordinary save that says nothing about the note.
  perform public.set_stock_level(v_product, v_place, null, 12, null, 'Restocked');
  perform test_assert(
    place_note(v_product, v_place) = 'Recount pending — pallet 2 opened',
    'a save that says nothing about the note leaves it there'
  );

  perform public.set_stock_level(v_product, v_place, null, null, null, null, null, '');
  perform test_assert(
    place_note(v_product, v_place) is null,
    'an empty note clears it'
  );

  perform public.set_stock_level(v_product, v_place, null, null, null, null, null, '   ');
  perform test_assert(
    place_note(v_product, v_place) is null,
    'and whitespace is emptiness rather than a note made of spaces'
  );
end;
$$;

-- =============================================================================
-- A note is not a movement.
--
-- stock_adjustments is what the on-hand total is accounted for by: every row
-- carries a delta and a quantity_after. A row that moved nothing would break
-- that reading, so editing a note writes none.
-- =============================================================================
do $$
declare
  v_product uuid := (select id from fixture where key = 'product');
  v_place   uuid := (select id from fixture where key = 'place');
  v_before  integer;
begin
  raise notice 'The ledger stays a ledger:';
  perform sign_in_as('admin_auth');

  v_before := adjustment_count(v_product);

  perform public.set_stock_level(v_product, v_place, null, null, null, null, null, 'Damaged');
  perform test_assert(
    adjustment_count(v_product) = v_before,
    'editing a note writes no adjustment'
  );

  perform public.set_stock_level(v_product, v_place, null, 15, null, 'Found more', null, 'Damaged');
  perform test_assert(
    adjustment_count(v_product) = v_before + 1,
    'while moving a quantity still does'
  );
end;
$$;

-- =============================================================================
-- The ordinary guards still apply.
-- =============================================================================
do $$
declare
  v_product uuid := (select id from fixture where key = 'product');
  v_place   uuid := (select id from fixture where key = 'place');
begin
  raise notice 'Refusals:';

  perform sign_in_as('ro_auth');
  begin
    perform public.set_stock_level(v_product, v_place, null, null, null, null, null, 'Mine now');
    perform test_assert(false, 'a read-only user should not be able to write a note');
  exception when others then
    perform test_assert(sqlerrm like '%does not allow%', 'a read-only user is refused');
  end;

  perform sign_in_as('admin_auth');
  begin
    perform public.set_stock_level(
      v_product, v_place, null, null, null, null, null, repeat('x', 501)
    );
    perform test_assert(false, 'an essay should not fit on a stock line');
  exception when others then
    perform test_assert(sqlerrm like '%too long%', 'a note over 500 characters is refused');
  end;

  perform test_assert(
    place_note(v_product, v_place) = 'Damaged',
    'and the note is still what it was'
  );

  -- One signature, not two. An overload differing by a defaulted argument is
  -- how PostgREST ends up choosing between them by guessing.
  perform test_assert(
    (select count(*) from pg_proc where proname = 'set_stock_level'
      and pronamespace = 'public'::regnamespace) = 1,
    'there is exactly one set_stock_level'
  );
end;
$$;

-- =============================================================================
-- Clearing the place takes the note with it.
-- =============================================================================
do $$
declare
  v_product uuid := (select id from fixture where key = 'product');
  v_place   uuid := (select id from fixture where key = 'place');
begin
  raise notice 'Removing the place:';
  perform sign_in_as('admin_auth');

  perform public.clear_stock_level(v_product, v_place, null, 'Moved out');

  perform test_assert(place_note(v_product, v_place) is null, 'the row and its note are gone');
  perform test_assert(
    adjustment_count(v_product) > 0,
    'and the movement down to zero is still in the history'
  );
end;
$$;

rollback;
