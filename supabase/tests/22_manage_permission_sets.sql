-- =============================================================================
-- Editing permission sets.
--
--   Step 1 left the table read-only. This covers the door: who may open it,
--   what it refuses, and the two lockouts it will not let anybody walk into.
--
--   The lockout tests matter most. Both failures they guard against are
--   unrecoverable from inside the app — nobody with manage_permissions means
--   the rules can never be edited again, and nobody with administer means
--   Settings is gone along with the screen that would fix it.
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

/** A set by name, since ids are generated and names are what the tests read. */
create or replace function set_id(p_name text)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select id from permission_sets
  where organization_id = (select id from fixture where key = 'org') and name = p_name;
$$;

grant execute on function set_id(text) to authenticated;

do $$
declare
  v_org   uuid;
  v_other uuid;
  r       record;
  v_auth  uuid;
  v_id    uuid;
begin
  insert into organizations (name, slug) values ('Door Co', 'door-co') returning id into v_org;
  insert into organizations (name, slug) values ('Their Door Co', 'their-door-co') returning id into v_other;

  for r in
    select unnest(array['admin','manager','regular']::user_role[]) as role
  loop
    v_auth := gen_random_uuid();
    insert into auth.users (id, email) values (v_auth, r.role || '@door.test');
    insert into users (organization_id, email, name, role, auth_provider_id, status)
    values (v_org, r.role || '@door.test', initcap(r.role::text), r.role, v_auth, 'active')
    returning id into v_id;
    insert into fixture values (r.role::text || '_auth', v_auth), (r.role::text, v_id);
  end loop;

  -- A second administrator, so the lockout tests have somewhere to step.
  v_auth := gen_random_uuid();
  insert into auth.users (id, email) values (v_auth, 'admin2@door.test');
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin2@door.test', 'Alt', 'admin', v_auth, 'active') returning id into v_id;
  insert into fixture values ('admin2_auth', v_auth), ('admin2', v_id);

  v_auth := gen_random_uuid();
  insert into auth.users (id, email) values (v_auth, 'admin@theirdoor.test');
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'admin@theirdoor.test', 'Bo', 'admin', v_auth, 'active');

  insert into fixture values ('org', v_org), ('other', v_other), ('their_admin_auth', v_auth);
end;
$$;

set local role authenticated;

-- =============================================================================
-- manage_permissions starts where administer already was.
--
-- An administrator could always change anybody's role, which is the same power
-- by a different route. Nothing is granted here that was not there before; what
-- is new is being able to take it away.
-- =============================================================================
do $$
begin
  perform sign_in_as('admin_auth');
  perform test_assert(public.can_manage_permissions(), 'an administrator may edit permission sets');

  perform sign_in_as('manager_auth');
  perform test_assert(not public.can_manage_permissions(), 'a manager may not');

  perform sign_in_as('regular_auth');
  perform test_assert(not public.can_manage_permissions(), 'nor a sales rep');
end;
$$;

-- =============================================================================
-- Creating, editing, deleting.
-- =============================================================================
do $$
declare v_id uuid;
begin
  perform sign_in_as('admin_auth');

  v_id := public.create_permission_set('Ops');
  perform test_assert(v_id is not null, 'a new set can be made');
  perform test_assert(
    not exists (select 1 from permission_sets where id = v_id and
      (see_all_records or write_records or administer or manage_permissions)),
    'and grants nothing at all until somebody ticks a box');

  perform public.update_permission_set(v_id, 'Ops', true, true, true, false, false, false, false, false, false);
  perform test_assert(
    (select see_all_records and write_records and not delete_records from permission_sets where id = v_id),
    'ticking boxes sticks — including leaving Delete unticked beside Create and edit');

  perform public.delete_permission_set(v_id);
  perform test_assert(not exists (select 1 from permission_sets where id = v_id),
    'and an empty set can go');
end;
$$;

-- =============================================================================
-- A set somebody is on cannot be deleted out from under them.
--
-- users.permission_set_id is `on delete set null`, so the row would survive the
-- delete with different permissions and no sign that anything had happened.
-- =============================================================================
do $$
declare v_id uuid; v_message text;
begin
  perform sign_in_as('admin_auth');

  v_id := public.create_permission_set('Temporary');
  perform public.assign_permission_set((select id from fixture where key = 'regular'), v_id);

  begin
    perform public.delete_permission_set(v_id);
    perform test_assert(false, 'a set with somebody on it is refused');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%Move them to another set first%',
    'and says to move them first');
  perform test_assert(
    (select permission_set_id from users where id = (select id from fixture where key = 'regular')) = v_id,
    'with the assignment untouched');

  perform public.assign_permission_set((select id from fixture where key = 'regular'), null);
  perform public.delete_permission_set(v_id);
  perform test_assert(not exists (select 1 from permission_sets where id = v_id),
    'once they are off it, it goes');
end;
$$;

-- =============================================================================
-- The seeded sets count as occupied too.
--
-- Nobody is assigned to them — everybody resolves to one through their role —
-- which is exactly the case a naive "is anybody assigned" check would miss.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('admin_auth');

  begin
    perform public.delete_permission_set(set_id('Sales rep'));
    perform test_assert(false, 'the set a rep resolves to by role is refused');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%1 person%', 'and counts the person on it');

  -- One nobody has: there is no sales_director in this organization.
  perform public.delete_permission_set(set_id('Sales director'));
  perform test_assert(set_id('Sales director') is null,
    'while a seeded set nobody resolves to can go');
end;
$$;

-- =============================================================================
-- Lockout: nobody left who can edit permissions.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('admin_auth');

  begin
    -- Administrator is the only set with manage_permissions, and both admins
    -- resolve to it.
    perform public.update_permission_set(
      set_id('Administrator'), 'Administrator',
      true, true, true, true, true, true, true, false, false);
    perform test_assert(false, 'unticking the last Manage permissions is refused');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%nobody able to edit permissions%',
    'and says so plainly, including that it would lock the person doing it out');
  perform test_assert(
    (select manage_permissions from permission_sets where id = set_id('Administrator')),
    'and the box is still ticked');
end;
$$;

-- =============================================================================
-- Lockout: nobody left who can reach Settings.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('admin_auth');

  begin
    perform public.update_permission_set(
      set_id('Administrator'), 'Administrator',
      true, true, true, true, true, true, false, true, false);
    perform test_assert(false, 'unticking the last Settings is refused');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%nobody able to reach Settings%', 'and says so');
end;
$$;

-- =============================================================================
-- But it is allowed once somebody else holds it.
--
-- The guard is about the organization ending up with nobody, not about any
-- particular person keeping anything — including the person making the change,
-- who is free to demote themselves as long as they are not the last one.
-- =============================================================================
do $$
declare v_keys uuid;
begin
  perform sign_in_as('admin_auth');

  v_keys := public.create_permission_set('Keyholder');
  perform public.update_permission_set(v_keys, 'Keyholder',
    true, true, true, true, true, true, true, true, false);
  perform public.assign_permission_set((select id from fixture where key = 'admin2'), v_keys);

  perform public.update_permission_set(
    set_id('Administrator'), 'Administrator',
    true, true, true, true, true, true, true, false, false);

  perform test_assert(
    not (select manage_permissions from permission_sets where id = set_id('Administrator')),
    'with a keyholder elsewhere, the Administrator set can give it up');

  perform sign_in_as('admin_auth');
  perform test_assert(not public.can_manage_permissions(),
    'and the person who did it has genuinely lost it');

  perform sign_in_as('admin2_auth');
  perform test_assert(public.can_manage_permissions(), 'while the keyholder still has it');

  -- Put it back for the tests below.
  perform public.update_permission_set(
    set_id('Administrator'), 'Administrator',
    true, true, true, true, true, true, true, true, false);
end;
$$;

-- =============================================================================
-- Who may open the door at all.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('manager_auth');

  begin
    perform public.create_permission_set('Sneaky');
    perform test_assert(false, 'a manager cannot create a set');
  exception when others then
    v_message := sqlerrm;
  end;
  perform test_assert(v_message like '%do not have permission%', 'and is told why');

  begin
    perform public.update_permission_set(set_id('Sales rep'), 'Sales rep',
      true, true, true, true, true, true, true, true, false);
    perform test_assert(false, 'nor edit one');
  exception when others then
    v_message := sqlerrm;
  end;
  perform test_assert(v_message like '%do not have permission%', 'and is told why');

  begin
    perform public.assign_permission_set(
      (select id from fixture where key = 'manager'), set_id('Administrator'));
    perform test_assert(false, 'nor put themselves on the Administrator set');
  exception when others then
    v_message := sqlerrm;
  end;
  perform test_assert(v_message like '%do not have permission%', 'and is told why');
  perform test_assert(not public.is_org_admin(), 'and is still not an administrator');
end;
$$;

-- =============================================================================
-- One organization cannot reach another's sets.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('their_admin_auth');

  begin
    perform public.update_permission_set(set_id('Administrator'), 'Theirs',
      true, true, true, true, true, true, true, true, false);
    perform test_assert(false, 'another organization''s set is out of reach');
  exception when others then
    v_message := sqlerrm;
  end;
  perform test_assert(v_message like '%not found%', 'it simply does not exist to them');

  begin
    perform public.assign_permission_set(
      (select id from fixture where key = 'regular'), null);
    perform test_assert(false, 'and neither are its people');
  exception when others then
    v_message := sqlerrm;
  end;
  perform test_assert(v_message like '%not found%', 'same answer, same reason');
end;
$$;

-- =============================================================================
-- Names are unique within an organization, and not across them.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('admin_auth');

  begin
    perform public.create_permission_set('administrator');
    perform test_assert(false, 'a second Administrator, differently cased, is refused');
  exception when others then
    v_message := sqlerrm;
  end;
  perform test_assert(v_message like '%already a permission set called%', 'and says which name');

  begin
    perform public.create_permission_set('   ');
    perform test_assert(false, 'and a set of spaces is not a name');
  exception when others then
    v_message := sqlerrm;
  end;
  perform test_assert(v_message like '%needs a name%', 'and says so');
end;
$$;

-- =============================================================================
-- What the screen reads to say "3 people" beside a set.
-- =============================================================================
do $$
declare v_members bigint;
begin
  perform sign_in_as('admin_auth');

  select m.members into v_members
  from public.permission_set_members() m
  where m.permission_set_id = set_id('Sales rep');

  perform test_assert(v_members = 1, 'the count sees people who resolve by role');

  select m.members into v_members
  from public.permission_set_members() m
  where m.permission_set_id = set_id('Keyholder');

  perform test_assert(v_members = 1, 'and people assigned directly');

  perform sign_in_as('their_admin_auth');
  perform test_assert(
    not exists (
      select 1 from public.permission_set_members() m
      where m.permission_set_id = set_id('Administrator')),
    'and another organization sees none of it');
end;
$$;

rollback;
