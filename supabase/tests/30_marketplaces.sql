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
--     * a save that says nothing about a field leaves it alone, and an emptied
--       one clears it — the rule every form on this record depends on;
--     * buyer's premium keeps its third state, because "nobody looked it up" is
--       not "there is none";
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

/** One field of a profile, read past every policy. */
create or replace function profile_text(p_company uuid, p_column text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_value text;
begin
  execute format('select %I::text from marketplace_profiles where company_id = $1', p_column)
  into v_value using p_company;
  return v_value;
end;
$$;

grant execute on function is_marketplace(uuid) to authenticated;
grant execute on function profile_text(uuid, text) to authenticated;

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
-- The fields that tell one channel from another.
--
-- The per-category rate card that used to be tested here is gone — see
-- 20260246000000. What replaced it is a note and a set of option values, so
-- what is worth holding is the null-leaves-it rule: a form that posts only what
-- it renders must not blank what it did not.
-- =============================================================================
do $$
declare
  v_auction uuid := (select id from fixture where key = 'auction');
begin
  raise notice 'What describes a marketplace:';
  perform sign_in_as('admin_auth');

  perform public.add_marketplace(v_auction, true, true);

  perform public.update_marketplace(
    p_company_id       => v_auction,
    p_fee_notes        => '15% seller fee, 3% processing',
    p_marketplace_type => array['Auction'],
    p_selling_cost     => 'High',
    p_audience         => array['B2B', 'B2C'],
    p_inventory_type   => array['Lots'],
    p_buyers_premium   => true,
    p_priority         => 'Critical'
  );

  perform test_assert(
    profile_text(v_auction, 'fee_notes') = '15% seller fee, 3% processing',
    'the fees are prose rather than a rate card'
  );
  perform test_assert(
    profile_text(v_auction, 'selling_cost') = 'High',
    'and the comparison is one field'
  );
  perform test_assert(
    profile_text(v_auction, 'audience') = '{B2B,B2C}',
    'a multi-select holds both answers'
  );
  perform test_assert(
    profile_text(v_auction, 'buyers_premium') = 'true',
    'and the premium is recorded'
  );

  -- An unrelated save must not blank any of it.
  perform public.update_marketplace(
    p_company_id => v_auction, p_store_name => 'Northern', p_buyers_premium => true
  );
  perform test_assert(
    profile_text(v_auction, 'selling_cost') = 'High'
      and profile_text(v_auction, 'audience') = '{B2B,B2C}'
      and profile_text(v_auction, 'fee_notes') = '15% seller fee, 3% processing',
    'a save that says nothing about them leaves them alone'
  );

  -- And an emptied one clears it, which is the other half of that rule.
  perform public.update_marketplace(
    p_company_id => v_auction, p_selling_cost => '', p_buyers_premium => true
  );
  perform test_assert(
    profile_text(v_auction, 'selling_cost') is null,
    'while an emptied field clears'
  );

  perform public.update_marketplace(
    p_company_id => v_auction, p_audience => '{}', p_buyers_premium => true
  );
  perform test_assert(
    profile_text(v_auction, 'audience') = '{}',
    'and an emptied multi-select clears too'
  );

  /*
   * Buyer's premium is the one field where null is a real answer — nobody has
   * looked it up — so it is written every time rather than following the
   * null-leaves-it rule the others do.
   */
  perform public.update_marketplace(p_company_id => v_auction, p_buyers_premium => null);
  perform test_assert(
    profile_text(v_auction, 'buyers_premium') is null,
    'and "not recorded" is a state the premium can go back to'
  );
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
  -- Dead schema is worse than none: it invites somebody to fill it in.
  perform test_assert(
    to_regclass('public.marketplace_fees') is null,
    'and the rate-card table is gone rather than left unused'
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
