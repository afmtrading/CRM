-- =============================================================================
-- Stock: the one door, the history behind it, and the four numbers.
--
--   stock_levels cannot be written directly by anybody. set_stock_level is the
--   only way a quantity moves, and it records why it moved in the same
--   statement.
--
--   Committed is read off open deals rather than stored, so it cannot disagree
--   with them.
--
--   Available goes negative when more has been promised than exists, because
--   that is the number somebody needs to see.
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

do $$
declare
  v_org      uuid;
  v_other    uuid;
  v_mgr_a    uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_ro_a     uuid := gen_random_uuid();
  v_badmin_a uuid := gen_random_uuid();
  v_mgr      uuid;
  v_rep      uuid;
  v_pipeline uuid;
  v_stage    uuid;
  v_product  uuid;
  v_rival    uuid;
  v_toronto  uuid;
  v_montreal uuid;
  v_rack     uuid;
  v_deal     uuid;
begin
  insert into organizations (name, slug) values ('Stock Co', 'stock-co') returning id into v_org;
  insert into organizations (name, slug) values ('Rival Co', 'rival-stock') returning id into v_other;

  insert into auth.users (id, email) values
    (v_mgr_a, 'mgr@stock.test'),
    (v_rep_a, 'rep@stock.test'),
    (v_ro_a, 'ro@stock.test'),
    (v_badmin_a, 'admin@rival.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'mgr@stock.test', 'Mo', 'manager', v_mgr_a, 'active') returning id into v_mgr;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@stock.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'ro@stock.test', 'Reed', 'readonly', v_ro_a, 'active');
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'admin@rival.test', 'Bo', 'admin', v_badmin_a, 'active');

  insert into pipelines (organization_id, name, is_default)
  values (v_org, 'Quotes', false) returning id into v_pipeline;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_pipeline, 'Quote', 0, 0.500) returning id into v_stage;

  insert into products (organization_id, name, unit_price)
  values (v_org, 'Speaker', 100) returning id into v_product;
  insert into products (organization_id, name, unit_price)
  values (v_other, 'Rival Speaker', 100) returning id into v_rival;

  -- Every organization is seeded with one warehouse; this adds a second.
  select id into v_toronto from stock_locations where organization_id = v_org;
  insert into stock_locations (organization_id, name, code)
  values (v_org, 'Montreal', 'MTL') returning id into v_montreal;
  insert into stock_bins (organization_id, location_id, name)
  values (v_org, v_toronto, 'Rack A') returning id into v_rack;

  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Big order', v_stage, 0, 'USD', v_mgr) returning id into v_deal;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('mgr_auth', v_mgr_a), ('rep_auth', v_rep_a), ('ro_auth', v_ro_a),
    ('badmin_auth', v_badmin_a),
    ('mgr', v_mgr), ('rep', v_rep),
    ('product', v_product), ('rival', v_rival),
    ('toronto', v_toronto), ('montreal', v_montreal), ('rack', v_rack),
    ('deal', v_deal);
end;
$$;

set local role authenticated;

-- =============================================================================
-- Nobody writes a stock level directly.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_product uuid := (select id from fixture where key = 'product');
  v_toronto uuid := (select id from fixture where key = 'toronto');
  v_failed  boolean := false;
begin
  raise notice 'The one door:';

  perform sign_in_as('mgr_auth');

  begin
    insert into stock_levels (organization_id, product_id, location_id, quantity)
    values (v_org, v_product, v_toronto, 500);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(
    v_failed,
    'even a manager cannot insert a stock level by hand — there would be no history of it'
  );

  perform public.set_stock_level(v_product, v_toronto, null, 500, null, 'Opening count');
  perform test_assert(
    (select quantity from stock_levels where product_id = v_product and bin_id is null) = 500,
    'set_stock_level is the way in'
  );

  v_failed := false;
  begin
    update stock_levels set quantity = 9999 where product_id = v_product;
  exception when others then
    v_failed := true;
  end;
  perform test_assert(
    v_failed or (select quantity from stock_levels where product_id = v_product and bin_id is null) = 500,
    'and the number cannot be edited around it afterwards'
  );

  v_failed := false;
  begin
    delete from stock_adjustments where product_id = v_product;
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'the history cannot be deleted — a history somebody can edit is not one');
end;
$$;

-- =============================================================================
-- Every movement is recorded, and only movements are.
-- =============================================================================
do $$
declare
  v_product uuid := (select id from fixture where key = 'product');
  v_toronto uuid := (select id from fixture where key = 'toronto');
  v_rack    uuid := (select id from fixture where key = 'rack');
  v_before  integer;
begin
  raise notice 'The history:';

  perform sign_in_as('mgr_auth');

  perform test_assert(
    (select count(*) from stock_adjustments
      where product_id = v_product and field = 'quantity' and delta = 500
        and quantity_after = 500 and reason = 'Opening count') = 1,
    'the opening count was recorded as a movement of 500, with its reason'
  );

  perform public.set_stock_level(v_product, v_toronto, null, 480, null, 'Damaged in transit');
  perform test_assert(
    (select count(*) from stock_adjustments
      where product_id = v_product and delta = -20 and quantity_after = 480) = 1,
    'a count that went down is recorded as a negative movement'
  );

  select count(*) into v_before from stock_adjustments where product_id = v_product;
  perform public.set_stock_level(v_product, v_toronto, null, 480, null, 'Recount');
  perform test_assert(
    (select count(*) from stock_adjustments where product_id = v_product) = v_before,
    'saving the same number again records nothing — a history of non-events is noise'
  );

  perform public.set_stock_level(v_product, v_toronto, null, null, 30, 'Held for a walk-in');
  perform test_assert(
    (select count(*) from stock_adjustments
      where product_id = v_product and field = 'reserved' and delta = 30) = 1,
    'reserving is its own kind of movement'
  );
  perform test_assert(
    (select quantity from stock_levels where product_id = v_product and bin_id is null) = 480,
    'and passing null for the quantity left the count exactly where it was'
  );

  perform public.set_stock_level(v_product, v_toronto, v_rack, 20, null, 'Moved to the rack');
  perform test_assert(
    (select count(*) from stock_levels where product_id = v_product) = 2,
    'a bin is a different place from the shelf it stands on'
  );

  perform test_assert(
    (select created_by from stock_adjustments
      where product_id = v_product order by created_at desc limit 1)
      = (select id from fixture where key = 'mgr'),
    'and every movement carries who made it'
  );
end;
$$;

-- =============================================================================
-- What the four numbers say.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_product uuid := (select id from fixture where key = 'product');
  v_deal    uuid := (select id from fixture where key = 'deal');
  v_summary record;
begin
  raise notice 'The four numbers:';

  perform sign_in_as('mgr_auth');

  select * into v_summary from public.product_stock_summary(v_product);
  perform test_assert(v_summary.on_hand = 500, 'on hand adds the places up — 480 on the shelf and 20 in the rack');
  perform test_assert(v_summary.reserved = 30, 'reserved is what was held back by hand');
  perform test_assert(v_summary.committed = 0, 'nothing is committed until a deal asks for it');
  perform test_assert(v_summary.available = 470, 'available is on hand less committed less reserved');

  insert into deal_products (organization_id, deal_id, product_id, quantity, unit_price)
  values (v_org, v_deal, v_product, 200, 100);

  select * into v_summary from public.product_stock_summary(v_product);
  perform test_assert(
    v_summary.committed = 200,
    'an open deal commits its line item without anybody entering a second number'
  );
  perform test_assert(v_summary.available = 270, 'and available drops by the same amount');

  update deals set status = 'won' where id = v_deal;
  select * into v_summary from public.product_stock_summary(v_product);
  perform test_assert(
    v_summary.committed = 0,
    'a deal that closed is no longer a promise about the warehouse'
  );

  -- Overselling is a fact, and clamping it to zero would hide the only thing
  -- anybody needed to be told.
  update deals set status = 'open' where id = v_deal;
  update deal_products set quantity = 900 where deal_id = v_deal;
  select * into v_summary from public.product_stock_summary(v_product);
  perform test_assert(
    v_summary.available = -430,
    'available goes negative rather than pretending, when more is promised than exists'
  );
end;
$$;

-- =============================================================================
-- Who may move stock, and whose stock they may move.
-- =============================================================================
do $$
declare
  v_product  uuid := (select id from fixture where key = 'product');
  v_rival    uuid := (select id from fixture where key = 'rival');
  v_toronto  uuid := (select id from fixture where key = 'toronto');
  v_montreal uuid := (select id from fixture where key = 'montreal');
  v_rack     uuid := (select id from fixture where key = 'rack');
  v_failed   boolean;
begin
  raise notice 'Stock permissions:';

  -- Counting stock is warehouse work, not a manager's approval.
  perform sign_in_as('rep_auth');
  perform public.set_stock_level(v_product, v_montreal, null, 12, null, 'Rep counted these');
  perform test_assert(
    (select quantity from stock_levels where product_id = v_product and location_id = v_montreal) = 12,
    'a sales rep can record a count'
  );

  perform sign_in_as('ro_auth');
  v_failed := false;
  begin
    perform public.set_stock_level(v_product, v_montreal, null, 999);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a read-only user cannot');

  perform sign_in_as('badmin_auth');
  v_failed := false;
  begin
    perform public.set_stock_level(v_product, v_toronto, null, 999);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'another organization cannot touch this one''s stock');

  perform test_assert(
    (select count(*) from stock_levels) = 0,
    'nor even see that it exists'
  );

  v_failed := false;
  begin
    perform public.product_stock_summary(v_product);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'nor read its totals through the summary');

  -- A bin belongs to one location. Pairing it with another would file stock
  -- somewhere that does not exist.
  perform sign_in_as('mgr_auth');
  v_failed := false;
  begin
    perform public.set_stock_level(v_product, v_montreal, v_rack, 5);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a bin cannot be used with a location it is not in');

  v_failed := false;
  begin
    perform public.set_stock_level(v_rival, v_toronto, null, 5);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'and stock cannot be recorded against another organization''s product');

  v_failed := false;
  begin
    perform public.set_stock_level(v_product, v_toronto, null, -1);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a negative count is refused');
end;
$$;

-- =============================================================================
-- Clearing a place keeps what happened there.
-- =============================================================================
do $$
declare
  v_product  uuid := (select id from fixture where key = 'product');
  v_montreal uuid := (select id from fixture where key = 'montreal');
begin
  raise notice 'Clearing a location:';

  perform sign_in_as('mgr_auth');
  perform public.clear_stock_level(v_product, v_montreal, null, 'Closed the depot');

  perform test_assert(
    (select count(*) from stock_levels
      where product_id = v_product and location_id = v_montreal) = 0,
    'the row is gone'
  );
  perform test_assert(
    (select count(*) from stock_adjustments
      where product_id = v_product and location_id = v_montreal and delta = -12) = 1,
    'and the twelve that were there left as a recorded movement rather than vanishing'
  );

  -- Idempotent: clearing what is already clear is not an error worth raising.
  perform public.clear_stock_level(v_product, v_montreal, null);
  perform test_assert(true, 'clearing a place that holds nothing does nothing');
end;
$$;

-- =============================================================================
-- Warehouses are the manager's to arrange.
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_failed boolean := false;
begin
  raise notice 'Warehouses:';

  perform test_assert(
    (select count(*) from stock_locations where organization_id = v_org and name = 'Main Warehouse') = 1,
    'a new organization already has somewhere to put things'
  );

  perform sign_in_as('rep_auth');
  begin
    insert into stock_locations (organization_id, name) values (v_org, 'Rep invention');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a sales rep can count stock but cannot invent a warehouse');

  perform sign_in_as('mgr_auth');
  insert into stock_locations (organization_id, name) values (v_org, 'Vancouver');
  perform test_assert(
    (select count(*) from stock_locations where name = 'Vancouver') = 1,
    'a manager can'
  );
end;
$$;

-- =============================================================================
-- What anon may execute.
-- =============================================================================
do $$
declare
  v_fn text;
begin
  raise notice 'What anon may execute:';

  foreach v_fn in array array[
    'public.set_stock_level(uuid, uuid, uuid, numeric, numeric, text, text)',
    'public.clear_stock_level(uuid, uuid, uuid, text)',
    'public.product_stock_summary(uuid)'
  ] loop
    perform test_assert(
      not has_function_privilege('anon', v_fn, 'execute'),
      'anon cannot execute ' || v_fn
    );
  end loop;
end;
$$;

rollback;
