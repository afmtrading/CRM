-- =============================================================================
-- Which columns each person's lists show.
--
--   A view preference, which sounds like nothing worth guarding until you
--   notice it is a per-user row in a multi-tenant table. What is held here:
--
--     * one row per person per list, so saving twice replaces rather than
--       accumulates;
--     * whose row it is comes from the session and never from the caller, so
--       nobody can write somebody else's;
--     * nobody reads anybody else's, administrators included — there is
--       nothing in here to administer;
--     * one organization cannot see another's, which is the rule every table
--       in this schema is held to whether or not the data looks sensitive.
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

/** Reads a preference past every policy, so a test can see what really landed. */
create or replace function stored_columns(p_user uuid, p_entity text)
returns text[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select columns from column_preferences
  where user_id = p_user and entity_type = p_entity;
$$;

grant execute on function stored_columns(uuid, text) to authenticated;

do $$
declare
  v_org     uuid;
  v_other   uuid;
  v_ada_a   uuid := gen_random_uuid();
  v_raj_a   uuid := gen_random_uuid();
  v_bo_a    uuid := gen_random_uuid();
  v_ada     uuid;
  v_raj     uuid;
  v_bo      uuid;
begin
  insert into organizations (name, slug) values ('Column Co', 'column-co') returning id into v_org;
  insert into organizations (name, slug) values ('Rival Columns', 'rival-columns')
  returning id into v_other;

  insert into auth.users (id, email) values
    (v_ada_a, 'ada@column.test'),
    (v_raj_a, 'raj@column.test'),
    (v_bo_a, 'bo@rival.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'ada@column.test', 'Ada', 'admin', v_ada_a, 'active') returning id into v_ada;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'raj@column.test', 'Raj', 'regular', v_raj_a, 'active') returning id into v_raj;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'bo@rival.test', 'Bo', 'admin', v_bo_a, 'active') returning id into v_bo;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('ada_auth', v_ada_a), ('raj_auth', v_raj_a), ('bo_auth', v_bo_a),
    ('ada', v_ada), ('raj', v_raj), ('bo', v_bo);
end;
$$;

set local role authenticated;

-- =============================================================================
-- Saving, and saving again.
-- =============================================================================
do $$
declare
  v_ada uuid := (select id from fixture where key = 'ada');
begin
  raise notice 'Saving a choice:';
  perform sign_in_as('ada_auth');

  perform public.save_column_preference('contact', array['name', 'owner', 'priority']);
  perform test_assert(
    stored_columns(v_ada, 'contact') = array['name', 'owner', 'priority'],
    'the choice is stored in the order it was given'
  );

  -- Saving again replaces. The unique index is what makes this an update rather
  -- than a second row nobody would ever read.
  perform public.save_column_preference('contact', array['name', 'email']);
  perform test_assert(
    stored_columns(v_ada, 'contact') = array['name', 'email'],
    'saving again replaces rather than adding a second row'
  );
  perform test_assert(
    (select count(*) from column_preferences where user_id = v_ada and entity_type = 'contact') = 1,
    'and there is still exactly one row'
  );

  -- Three lists, three independent rows.
  perform public.save_column_preference('company', array['name', 'based_in']);
  perform public.save_column_preference('product', array['name', 'status']);
  perform test_assert(
    stored_columns(v_ada, 'company') = array['name', 'based_in']
      and stored_columns(v_ada, 'contact') = array['name', 'email'],
    'each list is remembered separately'
  );
end;
$$;

-- =============================================================================
-- One person's choice is their own.
-- =============================================================================
do $$
declare
  v_ada uuid := (select id from fixture where key = 'ada');
  v_raj uuid := (select id from fixture where key = 'raj');
begin
  raise notice 'Whose row it is:';
  perform sign_in_as('raj_auth');

  perform public.save_column_preference('contact', array['name', 'lead_score']);

  perform test_assert(
    stored_columns(v_raj, 'contact') = array['name', 'lead_score'],
    'Raj gets his own row'
  );
  perform test_assert(
    stored_columns(v_ada, 'contact') = array['name', 'email'],
    'and Ada''s is untouched — the same list, two answers'
  );

  -- Reading through the policies rather than past them: Raj sees one row.
  perform test_assert(
    (select count(*) from column_preferences where entity_type = 'contact') = 1,
    'a colleague''s preference is not readable at all'
  );

  -- Nor writable, even naming their id outright.
  begin
    update column_preferences set columns = array['name']
    where user_id = v_ada and entity_type = 'contact';
  exception when others then
    null;
  end;
  perform test_assert(
    stored_columns(v_ada, 'contact') = array['name', 'email'],
    'and naming a colleague''s row does not change it'
  );
end;
$$;

-- =============================================================================
-- Not even an administrator.
--
-- Deliberate, and worth a test so it is not "fixed" later: there is nothing in
-- here to administer. A manager who could read one would learn only what a
-- colleague likes looking at.
-- =============================================================================
do $$
begin
  raise notice 'Administrators too:';
  perform sign_in_as('ada_auth');

  perform test_assert(
    (select count(*) from column_preferences where entity_type = 'contact') = 1,
    'an administrator sees their own row and no one else''s'
  );
end;
$$;

-- =============================================================================
-- Tenancy.
-- =============================================================================
do $$
declare
  v_ada uuid := (select id from fixture where key = 'ada');
begin
  raise notice 'Another organization:';
  perform sign_in_as('bo_auth');

  perform test_assert(
    (select count(*) from column_preferences) = 0,
    'another organization sees none of these rows'
  );

  perform public.save_column_preference('contact', array['name', 'source']);
  perform test_assert(
    stored_columns(v_ada, 'contact') = array['name', 'email'],
    'and saving their own leaves ours alone'
  );
end;
$$;

-- =============================================================================
-- Refusals, and forgetting.
-- =============================================================================
do $$
declare
  v_ada uuid := (select id from fixture where key = 'ada');
begin
  raise notice 'Refusals:';
  perform sign_in_as('ada_auth');

  begin
    perform public.save_column_preference('invoice', array['name']);
    perform test_assert(false, 'a list that does not exist should be refused');
  exception when others then
    perform test_assert(sqlerrm like '%no invoice list%', 'an unknown list is refused by name');
  end;

  begin
    perform public.save_column_preference(
      'contact',
      (select array_agg('c' || n) from generate_series(1, 41) as n)
    );
    perform test_assert(false, 'forty-one columns should be refused');
  exception when others then
    perform test_assert(sqlerrm like '%too many columns%', 'a runaway list is refused');
  end;

  perform test_assert(
    stored_columns(v_ada, 'contact') = array['name', 'email'],
    'and neither refusal changed anything'
  );

  -- Resetting forgets the row rather than storing today's defaults, so a
  -- column added next year still appears for somebody who once pressed reset.
  perform public.reset_column_preference('contact');
  perform test_assert(
    stored_columns(v_ada, 'contact') is null,
    'resetting forgets the choice entirely'
  );
  perform test_assert(
    stored_columns(v_ada, 'company') = array['name', 'based_in'],
    'and only the list that was reset'
  );
end;
$$;

rollback;
