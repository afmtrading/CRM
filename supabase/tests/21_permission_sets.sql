-- =============================================================================
-- Permission sets.
--
--   This file exists to prove a negative: that moving permissions out of
--   hardcoded role lists and into rows changed nobody's access.
--
--   The first block is the important one. It signs in as each of the five
--   roles in turn and asserts all seven capabilities against a table written
--   out by hand from the function bodies as they were before the change. Any
--   cell that moves fails here, loudly, naming the role and the capability.
--
--   The rest covers the machinery: that a new organization is seeded, that a
--   user's own set overrides their role's, that one organization cannot resolve
--   another's set, that an unseeded organization degrades to the old rule
--   rather than to nothing, and that nobody can write the table yet.
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

/** The seven capabilities as one row, so a role can be checked in one go. */
create or replace function capabilities()
returns table (
  see_all boolean, see_unassigned boolean, write_records boolean,
  delete_records boolean, manage_records boolean, bulk_records boolean, administer boolean
)
language sql
stable
as $$
  select
    public.can_see_all_records(),
    public.can_see_unassigned(),
    public.can_write_records(),
    public.can_delete_records(),
    public.can_manage_records(),
    public.can_bulk_records(),
    public.is_org_admin();
$$;

grant execute on function capabilities() to authenticated;

do $$
declare
  v_org   uuid;
  v_other uuid;
  r       record;
  v_auth  uuid;
  v_id    uuid;
begin
  insert into organizations (name, slug) values ('Perm Co', 'perm-co') returning id into v_org;
  insert into organizations (name, slug) values ('Their Perm Co', 'their-perm-co') returning id into v_other;

  -- One user per role, named for the role so failures read plainly.
  for r in
    select unnest(array['admin','manager','sales_director','regular','readonly']::user_role[]) as role
  loop
    v_auth := gen_random_uuid();
    insert into auth.users (id, email) values (v_auth, r.role || '@perm.test');
    insert into users (organization_id, email, name, role, auth_provider_id, status)
    values (v_org, r.role || '@perm.test', initcap(r.role::text), r.role, v_auth, 'active')
    returning id into v_id;
    insert into fixture values (r.role::text || '_auth', v_auth), (r.role::text, v_id);
  end loop;

  v_auth := gen_random_uuid();
  insert into auth.users (id, email) values (v_auth, 'admin@theirperm.test');
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'admin@theirperm.test', 'Bo', 'admin', v_auth, 'active');

  insert into fixture values ('org', v_org), ('other', v_other), ('their_admin_auth', v_auth);
end;
$$;

set local role authenticated;

-- =============================================================================
-- Nothing moved.
--
-- Written out from the function bodies as they stood before permission sets
-- existed:
--
--   can_see_all_records   in ('admin', 'manager')
--   can_see_unassigned    in ('admin', 'manager', 'sales_director', 'readonly')
--   can_write_records     in ('admin', 'manager', 'sales_director', 'regular')
--   can_delete_records    = can_write_records
--   can_manage_records    = can_see_all_records
--   can_bulk_records      in ('admin', 'manager', 'sales_director')
--   is_org_admin          role = 'admin'
-- =============================================================================
do $$
declare
  expected constant text[][] := array[
    -- role,           see_all, unassigned, write, delete, manage, bulk, administer
    array['admin',          't', 't', 't', 't', 't', 't', 't'],
    array['manager',        't', 't', 't', 't', 't', 't', 'f'],
    array['sales_director', 'f', 't', 't', 't', 'f', 't', 'f'],
    array['regular',        'f', 'f', 't', 't', 'f', 'f', 'f'],
    array['readonly',       'f', 't', 'f', 'f', 'f', 'f', 'f']
  ];
  v_role   text;
  v_got    boolean[];
  v_names  constant text[] := array[
    'can_see_all_records', 'can_see_unassigned', 'can_write_records',
    'can_delete_records', 'can_manage_records', 'can_bulk_records', 'is_org_admin'
  ];
  i integer;
  j integer;
begin
  for i in 1 .. array_length(expected, 1) loop
    v_role := expected[i][1];
    perform sign_in_as(v_role || '_auth');

    select array[c.see_all, c.see_unassigned, c.write_records,
                 c.delete_records, c.manage_records, c.bulk_records, c.administer]
    into v_got
    from capabilities() c;

    for j in 1 .. 7 loop
      perform test_assert(
        v_got[j] = (expected[i][j + 1] = 't'),
        format('%s: %s is %s', v_role, v_names[j], expected[i][j + 1] = 't'));
    end loop;
  end loop;
end;
$$;

-- =============================================================================
-- A new organization is seeded on the way in.
--
-- Without the trigger every one of its users would fall through to the
-- fallback — which works, and would hide the omission until somebody edited a
-- set and wondered why nothing happened.
-- =============================================================================
do $$
declare v_count integer;
begin
  perform sign_in_as('admin_auth');

  select count(*) into v_count
  from permission_sets where organization_id = (select id from fixture where key = 'org');

  perform test_assert(v_count = 5, 'an organization is seeded with five sets');

  select count(*) into v_count
  from permission_sets
  where organization_id = (select id from fixture where key = 'org') and administer;

  perform test_assert(v_count = 1, 'and exactly one of them holds the keys');
end;
$$;

-- =============================================================================
-- The seed is reachable by whoever actually creates organizations.
--
-- organizations has no insert policy at all, so nobody signed in makes one —
-- service_role does, during signup. The seeding trigger is not SECURITY
-- DEFINER, so it runs as whoever inserted the row and needs execute on
-- seed_permission_sets in its own right. The fixture above creates its
-- organizations as the superuser, which would never notice a missing grant.
--
-- Asserted rather than exercised: this harness does not reproduce Supabase's
-- default table privileges for service_role, so an insert as that role fails
-- here for a reason that has nothing to do with what is being tested. The grant
-- itself is the thing that would be missing in production, so the grant is what
-- is checked.
-- =============================================================================
do $$
begin
  perform test_assert(
    has_function_privilege('service_role', 'public.seed_permission_sets(uuid)', 'execute'),
    'service_role can seed an organization it creates');
  perform test_assert(
    not has_function_privilege('authenticated', 'public.seed_permission_sets(uuid)', 'execute'),
    'and nobody signed in can seed one');
  perform test_assert(
    not has_function_privilege('anon', 'public.seed_permission_sets(uuid)', 'execute'),
    'nor anyone who is not');
end;
$$;

-- =============================================================================
-- Editing a set moves the capability, without touching anybody's role.
--
-- This is the point of the whole migration, so it is worth stating as a test
-- rather than trusting that reading a column implies being able to change it.
-- =============================================================================
do $$
declare v_before boolean; v_after boolean;
begin
  perform sign_in_as('regular_auth');
  select public.can_bulk_records() into v_before;
  perform test_assert(v_before = false, 'a sales rep cannot bulk edit to begin with');

  -- Through the owner rather than the app: nothing may write this table yet.
  reset role;
  update permission_sets set bulk_records = true
  where organization_id = (select id from fixture where key = 'org') and role = 'regular';
  set local role authenticated;

  perform sign_in_as('regular_auth');
  select public.can_bulk_records() into v_after;
  perform test_assert(v_after = true, 'ticking the box on their set gives it to them');
  perform test_assert(
    (select role from users where id = (select id from fixture where key = 'regular')) = 'regular',
    'and their role did not move');

  reset role;
  update permission_sets set bulk_records = false
  where organization_id = (select id from fixture where key = 'org') and role = 'regular';
  set local role authenticated;
end;
$$;

-- =============================================================================
-- A user's own set beats the one their role points at.
--
-- The mechanism the next step is built on: sets that are not tied to a role at
-- all, assigned to people directly.
-- =============================================================================
do $$
declare v_set uuid;
begin
  reset role;

  insert into permission_sets (organization_id, name, see_all_records, write_records)
  values ((select id from fixture where key = 'org'), 'Ops', true, true)
  returning id into v_set;

  update users set permission_set_id = v_set
  where id = (select id from fixture where key = 'regular');

  set local role authenticated;
  perform sign_in_as('regular_auth');

  perform test_assert(public.can_see_all_records(),
    'a set of their own gives them what it says');
  perform test_assert(not public.is_org_admin(),
    'and withholds what it does not say');
  perform test_assert(
    (select role from users where id = (select id from fixture where key = 'regular')) = 'regular',
    'while their role stays what it was');

  reset role;
  update users set permission_set_id = null
  where id = (select id from fixture where key = 'regular');
  set local role authenticated;
end;
$$;

-- =============================================================================
-- One organization cannot resolve another's set.
--
-- current_permissions() is SECURITY DEFINER, so row-level security is not what
-- stops this — the organization_id in the join is. Which is exactly why it is
-- worth a test: a set id pasted from somewhere else has to resolve to nothing,
-- not to somebody else's permissions.
-- =============================================================================
do $$
declare v_theirs uuid;
begin
  reset role;

  select id into v_theirs from permission_sets
  where organization_id = (select id from fixture where key = 'other') and role = 'admin';

  update users set permission_set_id = v_theirs
  where id = (select id from fixture where key = 'readonly');

  set local role authenticated;
  perform sign_in_as('readonly_auth');

  perform test_assert(not public.is_org_admin(),
    'another organization''s administrator set grants nothing here');
  perform test_assert(not public.can_write_records(),
    'and the fallback answers instead, as read-only');

  reset role;
  update users set permission_set_id = null
  where id = (select id from fixture where key = 'readonly');
  set local role authenticated;
end;
$$;

-- =============================================================================
-- An organization with no sets at all degrades to yesterday, not to nothing.
--
-- This should never happen — the seed and the trigger between them cover every
-- organization there is or will be. It is tested because the failure it guards
-- against is an administrator locked out of the screen they would need to
-- unlock themselves, which is not a recoverable state.
-- =============================================================================
do $$
begin
  reset role;
  delete from permission_sets where organization_id = (select id from fixture where key = 'org');
  set local role authenticated;

  perform sign_in_as('admin_auth');
  perform test_assert(public.is_org_admin(), 'an unseeded administrator is still an administrator');
  perform test_assert(public.can_see_all_records(), 'and still sees every record');

  perform sign_in_as('readonly_auth');
  perform test_assert(not public.can_write_records(), 'an unseeded read-only user still cannot write');
  perform test_assert(public.can_see_unassigned(), 'and still sees unassigned records');

  reset role;
  perform public.seed_permission_sets((select id from fixture where key = 'org'));
  set local role authenticated;
end;
$$;

-- =============================================================================
-- Reading is allowed, writing is not — yet.
-- =============================================================================
do $$
declare v_count integer; v_message text;
begin
  perform sign_in_as('regular_auth');

  select count(*) into v_count
  from permission_sets where organization_id = (select id from fixture where key = 'org');
  perform test_assert(v_count = 5, 'anybody in the organization can read its sets');

  select count(*) into v_count
  from permission_sets where organization_id = (select id from fixture where key = 'other');
  perform test_assert(v_count = 0, 'and none of anybody else''s');

  begin
    update permission_sets set administer = true
    where organization_id = (select id from fixture where key = 'org') and role = 'regular';
    -- No update policy exists, so this is refused rather than silently ignored:
    -- the table has FORCE row level security and no policy to permit a write.
    perform test_assert(
      not exists (
        select 1 from permission_sets
        where organization_id = (select id from fixture where key = 'org')
          and role = 'regular' and administer),
      'a sales rep cannot grant themselves the keys');
  exception when insufficient_privilege then
    perform test_assert(true, 'a sales rep cannot grant themselves the keys');
  end;
end;
$$;

do $$
declare v_message text;
begin
  perform sign_in_as('admin_auth');

  begin
    update permission_sets set administer = true
    where organization_id = (select id from fixture where key = 'org') and role = 'regular';
    perform test_assert(
      not exists (
        select 1 from permission_sets
        where organization_id = (select id from fixture where key = 'org')
          and role = 'regular' and administer),
      'and neither can an administrator, until the screen for it exists');
  exception when insufficient_privilege then
    perform test_assert(true, 'and neither can an administrator, until the screen for it exists');
  end;
end;
$$;

rollback;
