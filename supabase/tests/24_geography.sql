-- =============================================================================
-- Where a company is, and where it trades.
--
--   The queries this exists for, taken verbatim from the request:
--
--     buyers who sell their products only in Canada
--     buyers based in Canada who sell in Canada and the USA
--     buyers who sell in the USA and also in Mexico
--
--   Each one is a different set operation — exactly equals, contains all,
--   contains all again over a different pair — and the last section runs all
--   three against a fixture built to make each of them return a different
--   answer. A test that passes because every company matches proves nothing.
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

/** A company's territory, read past the policies. */
create or replace function territory(p_name text)
returns text[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select sells_in from companies
  where organization_id = (select id from fixture where key = 'org') and name = p_name;
$$;

grant execute on function territory(text) to authenticated;

do $$
declare
  v_org  uuid;
  v_auth uuid := gen_random_uuid();
begin
  insert into organizations (name, slug) values ('Geo Co', 'geo-co') returning id into v_org;
  insert into auth.users (id, email) values (v_auth, 'admin@geo.test');
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@geo.test', 'Ada', 'admin', v_auth, 'active');
  insert into fixture values ('org', v_org), ('admin_auth', v_auth);
end;
$$;

set local role authenticated;

-- =============================================================================
-- ISO 3166 is the vocabulary, and nothing else is.
--
-- The whole reason territories are not an organization-editable option list:
-- somebody would add "North America", and then "sells in the USA" would quietly
-- stop finding half of them.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('admin_auth');

  begin
    insert into companies (organization_id, name, sells_in)
    values ((select id from fixture where key = 'org'), 'Bad Territory', array['North America']);
    perform test_assert(false, 'a made-up territory is refused');
  exception when others then
    v_message := sqlerrm;
  end;

  -- "country or region code" since the trading regions joined the list. The
  -- name is still refused; only the code is a territory.
  perform test_assert(v_message like '%is not a country or region code%',
    'and the message names the offending value rather than saying "invalid"');
  perform test_assert(v_message like '%ISO 3166%', 'and says what the vocabulary is');
end;
$$;

-- =============================================================================
-- A territory is normalised on the way in.
--
-- Sorting is the load-bearing part. Without it, "sells in exactly Canada and
-- the USA" would depend on the order somebody happened to type them in.
-- =============================================================================
do $$
begin
  perform sign_in_as('admin_auth');

  insert into companies (organization_id, name, sells_in)
  values ((select id from fixture where key = 'org'), 'Messy',
          array['us', ' ca ', 'US', '', 'mx']);

  perform test_assert(territory('Messy') = array['CA','MX','US'],
    'upper-cased, trimmed, blanks dropped, de-duplicated and sorted');

  perform test_assert(
    territory('Messy') = public.normalise_territory(array['MX','CA','US']),
    'so two identical territories written in different orders compare equal');
end;
$$;


-- =============================================================================
-- The three queries this was built for.
--
-- The fixture is arranged so each query returns a different set. If they all
-- returned the same companies the test would pass while proving nothing.
--
--   Only Canada        CA
--   Canada and USA     CA US       — based in Canada
--   USA and Mexico     MX US
--   North America      CA MX US
--   USA only           US          — based in the USA
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
  v_names text[];
begin
  perform sign_in_as('admin_auth');

  -- The companies the blocks above left behind go first. "Messy" sells in CA,
  -- MX and US, which would turn up in two of the three queries below and make
  -- them fail for a reason that has nothing to do with what they are testing.
  -- A query test whose answer depends on what ran before it is a test that
  -- breaks later, for somebody who did not write it.
  delete from companies where organization_id = v_org;

  insert into companies (organization_id, name, based_in, sells_in) values
    (v_org, 'Only Canada',    'CA', array['CA']),
    (v_org, 'Canada and USA', 'CA', array['CA','US']),
    (v_org, 'USA and Mexico', 'US', array['US','MX']),
    (v_org, 'North America',  'CA', array['CA','US','MX']),
    (v_org, 'USA only',       'US', array['US']);

  -- "sell their products only in Canada"
  select array_agg(name order by name) into v_names
  from companies where organization_id = v_org and sells_in = array['CA'];
  perform test_assert(v_names = array['Only Canada'],
    'only in Canada finds the one that sells nowhere else');

  -- "sell in Canada and the USA, but based in Canada"
  select array_agg(name order by name) into v_names
  from companies
  where organization_id = v_org and based_in = 'CA' and sells_in @> array['CA','US'];
  perform test_assert(v_names = array['Canada and USA','North America'],
    'Canada and the USA, based in Canada, finds both — including the one that also sells elsewhere');

  -- "sell in the USA but also sell in Mexico"
  select array_agg(name order by name) into v_names
  from companies where organization_id = v_org and sells_in @> array['US','MX'];
  perform test_assert(v_names = array['North America','USA and Mexico'],
    'the USA and also Mexico finds both, and not the ones selling only one of them');

  -- Sells anywhere in that pair, rather than both.
  perform test_assert(
    (select count(*) from companies where organization_id = v_org and sells_in && array['MX']) = 2,
    'and "sells in Mexico at all" is a different question with a different answer');

  -- Sells in none of them.
  perform test_assert(
    (select count(*) from companies
     where organization_id = v_org and cardinality(sells_in) > 0 and not (sells_in && array['MX'])) = 3,
    'as is "sells nowhere near Mexico"');
end;
$$;

-- =============================================================================
-- Editing a territory renormalises it.
--
-- A trigger that only fires on insert is a trigger that lets the second write
-- undo the first one's guarantees.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('admin_auth');

  update companies set sells_in = array['us','ca'] where name = 'Only Canada';
  perform test_assert(territory('Only Canada') = array['CA','US'],
    'an update sorts and upper-cases too');

  begin
    update companies set sells_in = array['CA','XX'] where name = 'Only Canada';
    perform test_assert(false, 'and validates too');
  exception when others then
    v_message := sqlerrm;
  end;
  perform test_assert(v_message like '%XX is not a country or region code%', 'naming the bad value');
end;
$$;

-- =============================================================================
-- The reference data is readable and not writable.
-- =============================================================================
do $$
declare v_count integer;
begin
  perform sign_in_as('admin_auth');

  select count(*) into v_count from countries;
  perform test_assert(v_count > 200, 'the country list is there in full');

  perform test_assert(
    (select name from countries where code = 'CA') = 'Canada', 'and says what CA is');
  -- The trading regions share the list, coded from the ISO user-assigned X
  -- series so they can sit behind the same foreign key as a country. Nine of
  -- them name a part of the world; the tenth, Global, means all of it.
  perform test_assert(
    (select count(*) from countries where kind = 'region') = 10,
    'and the ten trading regions are in it too');
  perform test_assert(
    (select name from countries where code = 'XN') = 'North America',
    'named rather than coded');
  perform test_assert(
    (select min(sort_order) from countries where kind = 'country')
      > (select max(sort_order) from countries where kind = 'region'),
    'and sorted ahead of every country, which is where they were asked to be');
  -- Global leads the regions, because a catch-all nobody scrolls past is a
  -- catch-all nobody uses.
  perform test_assert(
    (select code from countries order by sort_order, name limit 1) = 'XG',
    'with Global at the head of the whole list');

  -- A region is a place a company can be based, because based_in references
  -- countries and a region now lives there.
  insert into companies (organization_id, name, based_in)
  values ((select id from fixture where key = 'org'), 'Regional', 'XE');
  perform test_assert(
    (select based_in from companies where name = 'Regional') = 'XE',
    'and a company can be based in one');

  perform test_assert(
    not has_table_privilege('authenticated', 'public.countries', 'INSERT'),
    'and nobody signed in can add to it');
  perform test_assert(
    not has_table_privilege('authenticated', 'public.countries', 'UPDATE'),
    'or rename what is in it');
end;
$$;

-- =============================================================================
-- Stock type is its own list, beside merchandise.
--
-- "Medical" says what they deal in; "Overstock" says what condition it arrives
-- in. A buyer of medical overstock and a buyer of medical customer returns are
-- not the same call, and one list holding both cannot tell them apart.
-- =============================================================================
do $$
declare v_org uuid := (select id from fixture where key = 'org');
begin
  perform sign_in_as('admin_auth');

  perform test_assert(
    (select count(*) from field_options
     where organization_id = v_org and field_key = 'stock_type') = 6,
    'a new organization is seeded with the stock types');

  perform test_assert(
    (select count(*) from field_options
     where organization_id = v_org and field_key = 'specialty_market') = 5,
    'and still has its own merchandise list, untouched');

  update companies set stock_type = array['Overstock','Customer returns']
  where name = 'Only Canada';

  perform test_assert(
    (select count(*) from companies
     where organization_id = v_org and stock_type @> array['Overstock']) = 1,
    'and a company can be filtered by what condition of goods it takes');
end;
$$;

rollback;
