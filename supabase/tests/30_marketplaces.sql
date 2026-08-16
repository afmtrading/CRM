-- =============================================================================
-- Marketplaces.
--
--   A marketplace is a company with a profile, so the tests are mostly about
--   the seam between the two:
--
--     * promoting is idempotent — pressing the button twice is not two
--       marketplaces;
--     * demoting takes the rate card and leaves the company, its contacts and
--       its history, which is the whole reason the profile is separable;
--     * a company you cannot see cannot be promoted, because promoting one
--       would tell you it exists;
--     * a rate can only name a category this organization actually has, or the
--       product that has to match it would find nothing;
--     * both directions on one company, because an auctioneer who also buys is
--       one record and its two rate cards must not borrow from each other;
--     * the tables are readable and not writable — every change goes through a
--       function, the same one-door rule stock levels follow.
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

/** Reads past every policy, so a test can check what really landed. */
create or replace function is_marketplace(p_company uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from marketplace_profiles where company_id = p_company);
$$;

create or replace function fee_count(p_company uuid)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from marketplace_fees where marketplace_id = p_company;
$$;

create or replace function fee_percent(p_company uuid, p_side text, p_category text)
returns numeric
language sql
security definer
set search_path = public, pg_temp
as $$
  select percent from marketplace_fees
  where marketplace_id = p_company and side = p_side
    and category is not distinct from p_category;
$$;

grant execute on function is_marketplace(uuid) to authenticated;
grant execute on function fee_count(uuid) to authenticated;
grant execute on function fee_percent(uuid, text, text) to authenticated;

do $$
declare
  v_org     uuid;
  v_other   uuid;
  v_admin_a uuid := gen_random_uuid();
  v_ro_a    uuid := gen_random_uuid();
  v_rep_a   uuid := gen_random_uuid();
  v_bo_a    uuid := gen_random_uuid();
  v_admin   uuid;
  v_ro      uuid;
  v_rep     uuid;
  v_bo      uuid;
  v_ebay    uuid;
  v_auction uuid;
  v_quiet   uuid;
  v_theirs  uuid;
  v_person  uuid;
begin
  insert into organizations (name, slug) values ('Channel Co', 'channel-co') returning id into v_org;
  insert into organizations (name, slug) values ('Rival Channels', 'rival-channels')
  returning id into v_other;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@channel.test'),
    (v_ro_a, 'ro@channel.test'),
    (v_rep_a, 'rep@channel.test'),
    (v_bo_a, 'bo@rival.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@channel.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'ro@channel.test', 'Ola', 'readonly', v_ro_a, 'active') returning id into v_ro;
  -- A writer who cannot see hidden records: the case the hidden guard is for.
  -- The read-only user below is refused a step earlier, on can_write.
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@channel.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'bo@rival.test', 'Bo', 'admin', v_bo_a, 'active') returning id into v_bo;

  insert into companies (organization_id, name) values (v_org, 'BigBay') returning id into v_ebay;
  insert into companies (organization_id, name) values (v_org, 'Northern Auctions')
  returning id into v_auction;
  insert into companies (organization_id, name) values (v_org, 'Quiet Platform')
  returning id into v_quiet;
  insert into companies (organization_id, name) values (v_other, 'Their Platform')
  returning id into v_theirs;

  -- A contact at one of them, so demoting can be shown not to take it.
  insert into contacts (organization_id, first_name, last_name, company_id)
  values (v_org, 'Cat', 'Manager', v_ebay) returning id into v_person;

  -- The organization's own category vocabulary, which is what a rate keys on.
  insert into field_options (organization_id, entity_type, field_key, value, "order")
  values (v_org, 'product', 'product_category', 'Medical', 0),
         (v_org, 'product', 'product_category', 'Apparel', 1)
  on conflict do nothing;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_admin_a), ('ro_auth', v_ro_a), ('rep_auth', v_rep_a), ('bo_auth', v_bo_a),
    ('admin', v_admin),
    ('ebay', v_ebay), ('auction', v_auction), ('quiet', v_quiet), ('theirs', v_theirs),
    ('person', v_person);
end;
$$;

set local role authenticated;

-- Hiding takes see_hidden, so it happens as the administrator.
do $$
begin
  perform sign_in_as('admin_auth');
  update companies set hidden = true where id = (select id from fixture where key = 'quiet');
end;
$$;

-- =============================================================================
-- Promoting, and promoting again.
-- =============================================================================
do $$
declare
  v_ebay uuid := (select id from fixture where key = 'ebay');
begin
  raise notice 'Becoming a marketplace:';
  perform sign_in_as('admin_auth');

  perform public.add_marketplace(v_ebay);
  perform test_assert(is_marketplace(v_ebay), 'a company can be promoted');

  -- Idempotent: the button is on a page somebody can double-click.
  perform public.add_marketplace(v_ebay, true, true);
  perform test_assert(
    (select count(*) from marketplace_profiles where company_id = v_ebay) = 1,
    'promoting twice is still one marketplace'
  );
  perform test_assert(
    (select sources_from from marketplace_profiles where company_id = v_ebay),
    'and the second call updated the directions rather than being ignored'
  );

  -- A marketplace used for nothing is not a marketplace.
  begin
    perform public.add_marketplace(v_ebay, false, false);
    perform test_assert(false, 'neither direction should be refused');
  exception when others then
    perform test_assert(
      sqlerrm like '%sell through, source from, or both%',
      'a marketplace used in no direction is refused'
    );
  end;
end;
$$;

-- =============================================================================
-- A company you cannot see cannot be promoted.
--
-- Otherwise the button would be a way to discover that a hidden record exists.
-- =============================================================================
do $$
declare
  v_quiet  uuid := (select id from fixture where key = 'quiet');
  v_theirs uuid := (select id from fixture where key = 'theirs');
begin
  raise notice 'What cannot be promoted:';
  perform sign_in_as('ro_auth');

  begin
    perform public.add_marketplace(v_quiet);
    perform test_assert(false, 'a read-only user should not be able to promote');
  exception when others then
    perform test_assert(sqlerrm like '%does not allow%', 'a read-only user is refused');
  end;

  /*
   * The one the hidden clause is actually for: somebody who may write but may
   * not see hidden records. Promoting one would tell them it exists.
   */
  perform sign_in_as('rep_auth');
  begin
    perform public.add_marketplace(v_quiet);
    perform test_assert(false, 'a hidden company should not be promotable');
  exception when others then
    perform test_assert(
      sqlerrm like '%not found%',
      'a hidden company reads as not found rather than as refused'
    );
  end;
  perform test_assert(not is_marketplace(v_quiet), 'and it did not become one');

  -- Somebody with see_hidden promotes it normally.
  perform sign_in_as('admin_auth');
  perform public.add_marketplace(v_quiet);
  perform test_assert(is_marketplace(v_quiet), 'while see_hidden promotes it normally');
  perform public.remove_marketplace(v_quiet);

  begin
    perform public.add_marketplace(v_theirs);
    perform test_assert(false, 'another organization''s company should be refused');
  exception when others then
    perform test_assert(sqlerrm like '%not found%', 'another organization''s company is not found');
  end;
  perform test_assert(not is_marketplace(v_theirs), 'and it did not become one');
end;
$$;

-- =============================================================================
-- Two directions on one company.
--
-- An auction house takes a seller's commission one way and a buyer's premium
-- the other. The two cards live in one table and must not borrow each other's
-- numbers.
-- =============================================================================
do $$
declare
  v_auction uuid := (select id from fixture where key = 'auction');
begin
  raise notice 'Both directions:';
  perform sign_in_as('admin_auth');

  perform public.add_marketplace(v_auction, true, true);

  perform public.set_marketplace_fee(v_auction, 'sell', null, 12);
  perform public.set_marketplace_fee(v_auction, 'buy', null, 18);
  perform public.set_marketplace_fee(v_auction, 'sell', 'Medical', 8);

  perform test_assert(fee_percent(v_auction, 'sell', null) = 12, 'a selling rate is stored');
  perform test_assert(fee_percent(v_auction, 'buy', null) = 18, 'and a buying rate beside it');
  perform test_assert(
    fee_percent(v_auction, 'sell', 'Medical') = 8,
    'and a category rate beside that'
  );
  perform test_assert(fee_count(v_auction) = 3, 'three rows, not one overwriting another');

  -- Same side, same category, twice: a correction rather than a second rate.
  perform public.set_marketplace_fee(v_auction, 'sell', 'Medical', 9);
  perform test_assert(
    fee_percent(v_auction, 'sell', 'Medical') = 9 and fee_count(v_auction) = 3,
    'setting the same rate again corrects it rather than adding another'
  );

  -- And the fallback is one row, not one per save.
  perform public.set_marketplace_fee(v_auction, 'sell', null, 11);
  perform test_assert(
    fee_percent(v_auction, 'sell', null) = 11 and fee_count(v_auction) = 3,
    'the fallback rate is one row however often it is saved'
  );
end;
$$;

-- =============================================================================
-- A rate can only name a category the organization has.
--
-- Free text here would let "Medical" and "medical " become two rates, and the
-- product that has to match one of them would find neither.
-- =============================================================================
do $$
declare
  v_auction uuid := (select id from fixture where key = 'auction');
  v_ebay    uuid := (select id from fixture where key = 'ebay');
begin
  raise notice 'Categories:';
  perform sign_in_as('admin_auth');

  begin
    perform public.set_marketplace_fee(v_auction, 'sell', 'Nonsense', 5);
    perform test_assert(false, 'an unknown category should be refused');
  exception when others then
    perform test_assert(sqlerrm like '%No product category%', 'an unknown category is refused');
  end;

  begin
    perform public.set_marketplace_fee(v_auction, 'sideways', null, 5);
    perform test_assert(false, 'a side that is neither should be refused');
  exception when others then
    perform test_assert(
      sqlerrm like '%selling or on buying%',
      'a fee is charged on selling or buying and nothing else'
    );
  end;

  -- A rate on something that is not a marketplace has nowhere to hang.
  begin
    perform public.set_marketplace_fee(
      (select id from fixture where key = 'quiet'), 'sell', null, 5
    );
    perform test_assert(false, 'a rate on a non-marketplace should be refused');
  exception when others then
    perform test_assert(sqlerrm like '%Marketplace not found%', 'a rate needs a marketplace');
  end;

  perform test_assert(fee_count(v_ebay) = 0, 'and none of that left a stray row');
end;
$$;

-- =============================================================================
-- Demoting.
--
-- The rate card goes; everything that made it a company stays. That separation
-- is the entire argument for the profile being its own table.
-- =============================================================================
do $$
declare
  v_auction uuid := (select id from fixture where key = 'auction');
  v_ebay    uuid := (select id from fixture where key = 'ebay');
  v_person  uuid := (select id from fixture where key = 'person');
begin
  raise notice 'Stopping being one:';
  perform sign_in_as('admin_auth');

  perform public.remove_marketplace(v_auction);

  perform test_assert(not is_marketplace(v_auction), 'the profile is gone');
  perform test_assert(fee_count(v_auction) = 0, 'and the rate card went with it');
  perform test_assert(
    (select count(*) from companies where id = v_auction) = 1,
    'the company is still there'
  );

  perform test_assert(
    (select company_id from contacts where id = v_person) = v_ebay,
    'and a contact at a marketplace is untouched by any of this'
  );
end;
$$;

-- =============================================================================
-- One door.
--
-- Every change goes through a function. The tables grant select and nothing
-- else, so a caller cannot post straight at them and skip the checks above.
-- =============================================================================
do $$
declare
  v_ebay uuid := (select id from fixture where key = 'ebay');
begin
  raise notice 'What can be written directly:';
  perform sign_in_as('admin_auth');

  perform test_assert(
    (select count(*) from marketplace_profiles) = 1,
    'the profiles are readable'
  );

  perform test_assert(
    not has_table_privilege('authenticated', 'public.marketplace_profiles', 'insert')
      and not has_table_privilege('authenticated', 'public.marketplace_profiles', 'update')
      and not has_table_privilege('authenticated', 'public.marketplace_profiles', 'delete'),
    'and not writable except through the functions'
  );
  perform test_assert(
    not has_table_privilege('authenticated', 'public.marketplace_fees', 'insert')
      and not has_table_privilege('authenticated', 'public.marketplace_fees', 'update'),
    'nor are the rates'
  );

  perform test_assert(
    not has_function_privilege('anon', 'public.add_marketplace(uuid, boolean, boolean)', 'execute'),
    'and anon may not promote anything'
  );
end;
$$;

-- =============================================================================
-- Tenancy.
-- =============================================================================
do $$
begin
  raise notice 'Another organization:';
  perform sign_in_as('bo_auth');

  perform test_assert(
    (select count(*) from marketplace_profiles) = 0,
    'another organization sees none of these marketplaces'
  );
  perform test_assert(
    (select count(*) from marketplace_fees) = 0,
    'nor any of their rates'
  );

  begin
    perform public.remove_marketplace((select id from fixture where key = 'ebay'));
  exception when others then
    null;
  end;
  perform test_assert(
    is_marketplace((select id from fixture where key = 'ebay')),
    'and cannot demote ours'
  );
end;
$$;

-- =============================================================================
-- The columns picker knows about the new list.
-- =============================================================================
do $$
begin
  raise notice 'The list:';
  perform sign_in_as('admin_auth');

  perform public.save_column_preference('marketplace', array['name', 'take_rate']);
  perform test_assert(
    (select columns from column_preferences
      where user_id = (select id from fixture where key = 'admin')
        and entity_type = 'marketplace') = array['name', 'take_rate'],
    'a marketplace column choice can be saved'
  );

  begin
    perform public.save_column_preference('nonsense', array['name']);
    perform test_assert(false, 'an unknown list should still be refused');
  exception when others then
    perform test_assert(sqlerrm like '%no nonsense list%', 'and an unknown list is still refused');
  end;
end;
$$;

rollback;
