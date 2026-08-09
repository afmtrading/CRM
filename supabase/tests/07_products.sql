-- =============================================================================
-- Products, line items, and where a deal's value comes from.
--
--   The catalogue is shared reference data: everyone reads it, admins and
--   managers change it, ownership does not apply.
--
--   A line item follows its deal — visible to whoever can see the deal, and to
--   nobody else.
--
--   A deal with no value of its own adopts its line items. A deal somebody
--   priced by hand keeps that price until they say otherwise.
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
  v_org       uuid;
  v_other     uuid;
  v_admin_a   uuid := gen_random_uuid();
  v_mgr_a     uuid := gen_random_uuid();
  v_rep_a     uuid := gen_random_uuid();
  v_rep2_a    uuid := gen_random_uuid();
  v_badmin_a  uuid := gen_random_uuid();
  v_admin     uuid;
  v_mgr       uuid;
  v_rep       uuid;
  v_rep2      uuid;
  v_pipeline  uuid;
  v_stage     uuid;
  v_shea      uuid;
  v_cocoa     uuid;
  v_spare     uuid;
  v_rival     uuid;
  v_deal_rep  uuid;
  v_deal_mgr  uuid;
  v_deal_rep2 uuid;
begin
  insert into organizations (name, slug) values ('Product Co', 'product-co') returning id into v_org;
  insert into organizations (name, slug) values ('Rival Co', 'rival-co') returning id into v_other;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@prod.test'),
    (v_mgr_a, 'mgr@prod.test'),
    (v_rep_a, 'rep@prod.test'),
    (v_rep2_a, 'rep2@prod.test'),
    (v_badmin_a, 'admin@rival.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@prod.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'mgr@prod.test', 'Mo', 'manager', v_mgr_a, 'active') returning id into v_mgr;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@prod.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep2@prod.test', 'Rita', 'regular', v_rep2_a, 'active') returning id into v_rep2;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'admin@rival.test', 'Bo', 'admin', v_badmin_a, 'active');

  -- Not the default: creating an organization already seeds one.
  insert into pipelines (organization_id, name, is_default)
  values (v_org, 'Quotes', false) returning id into v_pipeline;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_pipeline, 'Quote', 0, 0.500) returning id into v_stage;

  insert into products (organization_id, name, sku, category, unit, unit_price, unit_cost, currency)
  values (v_org, 'Shea Butter', 'SHEA-1', 'Butters', 'kg', 10, 6, 'CAD') returning id into v_shea;
  insert into products (organization_id, name, sku, category, unit, unit_price, unit_cost, currency)
  values (v_org, 'Cocoa Powder', 'COCOA-1', 'Powders', 'kg', 5, 3, 'CAD') returning id into v_cocoa;
  insert into products (organization_id, name, unit_price)
  values (v_org, 'Discontinued Sample', 1) returning id into v_spare;
  insert into products (organization_id, name, unit_price)
  values (v_other, 'Rival Product', 99) returning id into v_rival;

  -- One deal nobody has priced, one already priced by hand.
  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Rep quote', v_stage, 0, 'CAD', v_rep) returning id into v_deal_rep;
  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Manager quote', v_stage, 5000, 'CAD', v_mgr) returning id into v_deal_mgr;
  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Rita quote', v_stage, 0, 'CAD', v_rep2) returning id into v_deal_rep2;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_admin_a), ('mgr_auth', v_mgr_a), ('rep_auth', v_rep_a),
    ('rep2_auth', v_rep2_a), ('badmin_auth', v_badmin_a),
    ('admin', v_admin), ('mgr', v_mgr), ('rep', v_rep), ('rep2', v_rep2),
    ('pipeline', v_pipeline), ('stage', v_stage),
    ('shea', v_shea), ('cocoa', v_cocoa), ('spare', v_spare), ('rival', v_rival),
    ('deal_rep', v_deal_rep), ('deal_mgr', v_deal_mgr), ('deal_rep2', v_deal_rep2);
end;
$$;

set local role authenticated;

-- =============================================================================
-- The catalogue is shared, and stops at the organization boundary.
-- =============================================================================
do $$
begin
  raise notice 'Catalogue visibility:';

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from products) = 3,
    'a sales rep reads the whole catalogue — ownership does not apply to it'
  );
  perform test_assert(
    (select count(*) from products where name = 'Rival Product') = 0,
    'another organization''s catalogue is invisible'
  );

  perform sign_in_as('badmin_auth');
  perform test_assert(
    (select count(*) from products) = 1,
    'the other organization sees only its own'
  );
end;
$$;

-- =============================================================================
-- Changing the catalogue is a manager's job.
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_shea   uuid := (select id from fixture where key = 'shea');
  v_spare  uuid := (select id from fixture where key = 'spare');
  v_failed boolean := false;
begin
  raise notice 'Catalogue permissions:';

  perform sign_in_as('rep_auth');
  begin
    insert into products (organization_id, name) values (v_org, 'Rep invention');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a sales rep cannot add a product');

  update products set unit_price = 1 where id = v_shea;
  perform test_assert(
    (select unit_price from products where id = v_shea) = 10,
    'a sales rep cannot re-price a product'
  );

  perform sign_in_as('mgr_auth');
  insert into products (organization_id, name, unit_price) values (v_org, 'Manager addition', 7);
  perform test_assert(
    (select count(*) from products where name = 'Manager addition') = 1,
    'a manager can add a product'
  );

  update products set unit_price = 11 where id = v_shea;
  perform test_assert(
    (select unit_price from products where id = v_shea) = 11,
    'a manager can re-price a product'
  );

  delete from products where id = v_spare;
  perform test_assert(
    (select count(*) from products where id = v_spare) = 1,
    'a manager cannot destroy a product outright'
  );

  perform sign_in_as('admin_auth');
  delete from products where id = v_spare;
  perform test_assert(
    (select count(*) from products where id = v_spare) = 0,
    'an administrator can, for a product nothing refers to'
  );
end;
$$;

-- =============================================================================
-- A deal nobody has priced follows its line items.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_deal  uuid := (select id from fixture where key = 'deal_rep');
  v_shea  uuid := (select id from fixture where key = 'shea');
  v_cocoa uuid := (select id from fixture where key = 'cocoa');
  v_line  uuid;
begin
  raise notice 'Deal value from line items:';

  perform sign_in_as('rep_auth');

  insert into deal_products (organization_id, deal_id, product_id, quantity, unit_price, unit_cost)
  values (v_org, v_deal, v_shea, 100, 10, 6)
  returning id into v_line;

  perform test_assert(
    (select value_source from deals where id = v_deal) = 'products',
    'an unpriced deal adopts its line items'
  );
  perform test_assert(
    (select value from deals where id = v_deal) = 1000,
    'the value is the sum of the lines'
  );

  insert into deal_products (organization_id, deal_id, product_id, quantity, unit_price, unit_cost)
  values (v_org, v_deal, v_cocoa, 50, 5, 3);
  perform test_assert(
    (select value from deals where id = v_deal) = 1250,
    'adding a line adds to the value'
  );

  update deal_products set quantity = 200 where id = v_line;
  perform test_assert(
    (select value from deals where id = v_deal) = 2250,
    'changing a quantity changes the value'
  );

  update deal_products set discount_pct = 10 where id = v_line;
  perform test_assert(
    (select line_total from deal_products where id = v_line) = 1800,
    'a discount comes off the line total'
  );
  perform test_assert(
    (select value from deals where id = v_deal) = 2050,
    'and off the deal'
  );

  delete from deal_products where id = v_line;
  perform test_assert(
    (select value from deals where id = v_deal) = 250,
    'removing a line takes its money with it'
  );
end;
$$;

-- =============================================================================
-- A deal somebody priced keeps its price.
-- =============================================================================
do $$
declare
  v_org  uuid := (select id from fixture where key = 'org');
  v_deal uuid := (select id from fixture where key = 'deal_mgr');
  v_shea uuid := (select id from fixture where key = 'shea');
begin
  raise notice 'Hand-typed values:';

  perform sign_in_as('mgr_auth');

  insert into deal_products (organization_id, deal_id, product_id, quantity, unit_price, unit_cost)
  values (v_org, v_deal, v_shea, 10, 10, 6);

  perform test_assert(
    (select value_source from deals where id = v_deal) = 'manual',
    'a deal with a typed value does not silently switch to its line items'
  );
  perform test_assert(
    (select value from deals where id = v_deal) = 5000,
    'and keeps the number that was typed'
  );

  perform set_deal_value_from_products(v_deal);
  perform test_assert(
    (select value from deals where id = v_deal) = 100
      and (select value_source from deals where id = v_deal) = 'products',
    'until someone asks for the line items instead'
  );
end;
$$;

-- =============================================================================
-- A line item's price is frozen when it is added.
-- =============================================================================
do $$
declare
  v_deal uuid := (select id from fixture where key = 'deal_mgr');
  v_shea uuid := (select id from fixture where key = 'shea');
begin
  raise notice 'Frozen prices:';

  perform sign_in_as('mgr_auth');
  update products set unit_price = 999, unit_cost = 500 where id = v_shea;

  perform test_assert(
    (select sum(line_total) from deal_products where deal_id = v_deal) = 100,
    're-pricing the catalogue does not rewrite what a deal was worth'
  );
  perform test_assert(
    (select sum(line_cost) from deal_products where deal_id = v_deal) = 60,
    'nor what it cost'
  );
end;
$$;

-- =============================================================================
-- Line items belong to one organization, and to one deal's audience.
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_deal   uuid := (select id from fixture where key = 'deal_rep');
  v_rival  uuid := (select id from fixture where key = 'rival');
  v_failed boolean := false;
begin
  raise notice 'Line item boundaries:';

  perform sign_in_as('mgr_auth');
  begin
    insert into deal_products (organization_id, deal_id, product_id, quantity, unit_price)
    values (v_org, v_deal, v_rival, 1, 1);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a deal cannot list another organization''s product');

  perform sign_in_as('rep2_auth');
  perform test_assert(
    (select count(*) from deal_products where deal_id = v_deal) = 0,
    'a rep cannot see the line items of a deal they cannot see'
  );

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from deal_products where deal_id = v_deal) = 1,
    'the deal''s owner can'
  );

  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select count(*) from deal_products where deal_id = v_deal) = 1,
    'and so can a manager, who sees every deal'
  );
end;
$$;

-- =============================================================================
-- Deleting a product.
-- =============================================================================
do $$
declare
  v_cocoa  uuid := (select id from fixture where key = 'cocoa');
  v_failed boolean := false;
begin
  raise notice 'Product deletion:';

  perform sign_in_as('rep_auth');
  begin
    perform soft_delete_product(v_cocoa);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a sales rep cannot delete a product');

  perform sign_in_as('mgr_auth');
  perform soft_delete_product(v_cocoa);
  perform test_assert(
    (select deleted_at from products where id = v_cocoa) is not null,
    'a manager can'
  );

  -- Deliberately unlike a deleted contact: a line item on a closed deal has to
  -- keep rendering its product's name, and a discontinued SKU is not
  -- confidential. Lists filter deleted rows out instead.
  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from products where id = v_cocoa) = 1,
    'a deleted product stays readable, so old line items still render'
  );

  v_failed := false;
  begin
    perform restore_product(v_cocoa);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'restoring is not a rep''s to do');

  perform sign_in_as('admin_auth');
  perform restore_product(v_cocoa);
  perform test_assert(
    (select deleted_at from products where id = v_cocoa) is null,
    'an administrator restores it'
  );
end;
$$;

-- The administrators hear about it, exactly as they do for a contact.
do $$
begin
  perform sign_in_as('admin_auth');
  perform test_assert(
    (select count(*) from notifications where kind = 'product_deleted') = 1,
    'the administrator is notified that a product was deleted'
  );
  perform test_assert(
    (select title from notifications where kind = 'product_deleted') = 'Product deleted: Cocoa Powder',
    'the notice names the product'
  );

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from notifications) = 0,
    'a sales rep is not copied in'
  );
end;
$$;

-- A product a deal still lists cannot be destroyed, only retired.
do $$
declare
  v_shea   uuid := (select id from fixture where key = 'shea');
  v_failed boolean := false;
begin
  perform sign_in_as('admin_auth');
  begin
    delete from products where id = v_shea;
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a product a deal still lists cannot be destroyed');
end;
$$;

-- =============================================================================
-- What are we selling, and to whom.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_rep   uuid := (select id from fixture where key = 'rep');
  v_shea  uuid := (select id from fixture where key = 'shea');
  v_cocoa uuid := (select id from fixture where key = 'cocoa');
begin
  raise notice 'Product mix report:';

  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select count(*) from report_product_mix()) = 2,
    'the report covers every product with a line item'
  );
  perform test_assert(
    (select total_value from report_product_mix() where product_id = v_cocoa) = 250,
    'totals come from the line items'
  );
  perform test_assert(
    (select weighted_value from report_product_mix() where product_id = v_cocoa) = 125,
    'weighted by the deal''s own probability'
  );
  perform test_assert(
    (select margin from report_product_mix() where product_id = v_cocoa) = 100,
    'margin is what is left after cost'
  );
  perform test_assert(
    (select currency from report_product_mix() where product_id = v_cocoa) = 'CAD',
    'and each currency is counted separately, never added together'
  );

  perform sign_in_as('rep2_auth');
  perform test_assert(
    (select count(*) from report_product_mix()) = 0,
    'a rep with no line items of their own sees an empty report, not the team''s'
  );

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from report_product_mix()) = 1,
    'a rep sees only what their own deals are for'
  );
end;
$$;

-- =============================================================================
-- What a contact has asked about.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_shea    uuid := (select id from fixture where key = 'shea');
  v_rep     uuid := (select id from fixture where key = 'rep');
  v_contact uuid;
begin
  raise notice 'Product interest:';

  perform sign_in_as('rep_auth');
  insert into contacts (organization_id, first_name, owner_id)
  values (v_org, 'Interested', v_rep) returning id into v_contact;

  insert into contact_products (organization_id, contact_id, product_id)
  values (v_org, v_contact, v_shea);

  perform test_assert(
    (select count(*) from contact_products where contact_id = v_contact) = 1,
    'a rep records what their own contact asked about'
  );

  perform sign_in_as('rep2_auth');
  perform test_assert(
    (select count(*) from contact_products where contact_id = v_contact) = 0,
    'and another rep sees neither the contact nor its interests'
  );
end;
$$;

rollback;
