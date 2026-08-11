-- =============================================================================
-- Pipeline ordering.
--
--   The bar above the deals board used to be alphabetical, which is a fact
--   about the names rather than a decision about which desk matters most.
--   Pipelines now carry their own order, placed the same way stages are: by
--   renumbering the whole set, so a position asked for is the position taken.
--
--   These tests cover the same ground as 09_stage_ordering — placement,
--   the ends of the list, one nudge at a time, who may do it, and that one
--   organization's bar cannot be reached from another.
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

/** The organization's pipelines, in the order the bar would draw them. */
create or replace function pipeline_names(p_org uuid)
returns text[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select array_agg(name order by "order", created_at, id)
  from pipelines
  where organization_id = p_org;
$$;

grant execute on function pipeline_names(uuid) to authenticated;

/** The positions themselves, to prove they are contiguous and unique. */
create or replace function pipeline_positions(p_org uuid)
returns integer[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select array_agg("order" order by "order", created_at, id)
  from pipelines
  where organization_id = p_org;
$$;

grant execute on function pipeline_positions(uuid) to authenticated;

do $$
declare
  v_org      uuid;
  v_other    uuid;
  v_admin_a  uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_badmin_a uuid := gen_random_uuid();
  v_admin    uuid;
  v_rep      uuid;
  v_badmin   uuid;
  v_trading  uuid;
  v_broking  uuid;
  v_shipping uuid;
  v_theirs   uuid;
begin
  insert into organizations (name, slug) values ('Bar Co', 'bar-co') returning id into v_org;
  insert into organizations (name, slug) values ('Other Bar Co', 'other-bar-co') returning id into v_other;

  -- Every organization is seeded with a default pipeline. It is not what these
  -- tests are about, and leaving it in would put a fourth name in every
  -- assertion, so it goes.
  delete from pipelines where organization_id in (v_org, v_other);

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@bar.test'),
    (v_rep_a, 'rep@bar.test'),
    (v_badmin_a, 'admin@otherbar.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@bar.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@bar.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'admin@otherbar.test', 'Bo', 'admin', v_badmin_a, 'active') returning id into v_badmin;

  insert into pipelines (organization_id, name, is_default, "order")
  values (v_org, 'Trading', false, 0) returning id into v_trading;
  insert into pipelines (organization_id, name, is_default, "order")
  values (v_org, 'Broking', false, 1) returning id into v_broking;
  insert into pipelines (organization_id, name, is_default, "order")
  values (v_org, 'Shipping', false, 2) returning id into v_shipping;

  insert into pipelines (organization_id, name, is_default, "order")
  values (v_other, 'Theirs', false, 0) returning id into v_theirs;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_admin_a), ('rep_auth', v_rep_a), ('badmin_auth', v_badmin_a),
    ('trading', v_trading), ('broking', v_broking), ('shipping', v_shipping),
    ('theirs', v_theirs);
end;
$$;

set local role authenticated;

-- =============================================================================
-- The bar keeps the order it was given, not the alphabet.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
begin
  raise notice 'Placing a pipeline:';
  perform sign_in_as('admin_auth');

  perform test_assert(
    pipeline_names(v_org) = array['Trading', 'Broking', 'Shipping'],
    'the bar starts in the order it was built, not alphabetically'
  );

  perform reorder_pipeline((select id from fixture where key = 'shipping'), 1);

  perform test_assert(
    pipeline_names(v_org) = array['Trading', 'Shipping', 'Broking'],
    'a pipeline sent to position 1 is second, and the one it displaced moves along'
  );

  perform test_assert(
    pipeline_positions(v_org) = array[0, 1, 2],
    'and the positions are renumbered contiguously, with no duplicates left behind'
  );
end;
$$;

-- =============================================================================
-- The ends of the list behave.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
begin
  raise notice 'Edges:';
  perform sign_in_as('admin_auth');

  perform reorder_pipeline((select id from fixture where key = 'trading'), 99);
  perform test_assert(
    pipeline_names(v_org) = array['Shipping', 'Broking', 'Trading'],
    'a position past the end means last, rather than an error'
  );

  perform reorder_pipeline((select id from fixture where key = 'trading'), -5);
  perform test_assert(
    pipeline_names(v_org) = array['Trading', 'Shipping', 'Broking'],
    'and a negative one means first'
  );

  perform test_assert(
    pipeline_positions(v_org) = array[0, 1, 2],
    'the positions stay contiguous through both'
  );
end;
$$;

-- =============================================================================
-- Moving one place at a time — what the arrows in settings do.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
begin
  raise notice 'Moving earlier and later:';
  perform sign_in_as('admin_auth');

  perform move_pipeline((select id from fixture where key = 'broking'), -1);
  perform test_assert(
    pipeline_names(v_org) = array['Trading', 'Broking', 'Shipping'],
    'moving a pipeline earlier swaps it with the one before'
  );

  perform move_pipeline((select id from fixture where key = 'trading'), 1);
  perform test_assert(
    pipeline_names(v_org) = array['Broking', 'Trading', 'Shipping'],
    'and moving one later swaps it with the one after'
  );

  -- The interface disables these, but the function should not depend on that.
  perform move_pipeline((select id from fixture where key = 'broking'), -1);
  perform test_assert(
    pipeline_names(v_org) = array['Broking', 'Trading', 'Shipping'],
    'moving the first pipeline earlier does nothing, rather than falling off the list'
  );

  perform move_pipeline((select id from fixture where key = 'shipping'), 1);
  perform test_assert(
    pipeline_names(v_org) = array['Broking', 'Trading', 'Shipping'],
    'and moving the last one later does nothing either'
  );
end;
$$;

-- =============================================================================
-- Who may reorder, and whose pipelines they may reach.
-- =============================================================================
do $$
declare
  v_failed boolean := false;
  v_org    uuid := (select id from fixture where key = 'org');
begin
  raise notice 'Permission:';

  perform sign_in_as('rep_auth');
  begin
    perform reorder_pipeline((select id from fixture where key = 'shipping'), 0);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a rep cannot reorder pipelines');

  v_failed := false;
  perform sign_in_as('rep_auth');
  begin
    perform move_pipeline((select id from fixture where key = 'shipping'), -1);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'nor move one');

  perform sign_in_as('admin_auth');
  perform test_assert(
    pipeline_names(v_org) = array['Broking', 'Trading', 'Shipping'],
    'and nothing they tried actually moved'
  );

  -- The function runs as definer, so the organization check inside it is the
  -- only thing standing between two tenants.
  v_failed := false;
  perform sign_in_as('badmin_auth');
  begin
    perform reorder_pipeline((select id from fixture where key = 'shipping'), 0);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(
    v_failed,
    'an administrator of another organization cannot reach these pipelines at all'
  );
end;
$$;

-- =============================================================================
-- One organization's bar is its own.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_other uuid := (select id from fixture where key = 'other');
begin
  raise notice 'Isolation:';
  perform sign_in_as('admin_auth');

  perform reorder_pipeline((select id from fixture where key = 'shipping'), 0);

  perform test_assert(
    pipeline_names(v_other) = array['Theirs'],
    'renumbering one organization''s bar leaves another''s untouched'
  );
  perform test_assert(
    pipeline_positions(v_org) = array[0, 1, 2],
    'and the reordered bar is still contiguous'
  );
end;
$$;

-- =============================================================================
-- Notes on a deal.
--
-- One column, but it is the one place a deal says what it is actually about,
-- so it should be reachable under the same rules as the rest of the row.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_stage uuid;
  v_deal  uuid;
begin
  raise notice 'Deal notes:';

  perform sign_in_as('admin_auth');

  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, (select id from fixture where key = 'trading'), 'New', 0, 0.5)
  returning id into v_stage;

  -- Owned by the rep, because a rep only sees their own deals — the note has
  -- to be reachable by the person whose deal it is.
  insert into deals (organization_id, name, stage_id, owner_id, notes)
  values (
    v_org,
    'Cargo of maize',
    v_stage,
    (select id from users where organization_id = v_org and role = 'regular'),
    E'# Terms\n\n- CIF Rotterdam\n- **60 days** credit'
  )
  returning id into v_deal;

  perform test_assert(
    (select notes from deals where id = v_deal) like '# Terms%',
    'a deal keeps the markdown it was given, verbatim'
  );

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select notes from deals where id = v_deal) like '%60 days%',
    'the rep who owns the deal can read its notes'
  );

  perform sign_in_as('badmin_auth');
  perform test_assert(
    (select count(*) from deals where id = v_deal) = 0,
    'and another organization cannot see it at all'
  );
end;
$$;

rollback;
