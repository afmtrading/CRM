-- =============================================================================
-- Editing permission sets
--
-- Step 1 made permissions data and left the table read-only, because a table
-- that can be changed before anything can show the change is a table that gets
-- changed by accident. This adds the door.
--
-- A SEPARATE CAPABILITY FOR EDITING THEM
--
-- The obvious rule is "whoever has administer may edit sets". That hands every
-- administrator the ability to grant themselves anything, which makes every
-- other capability advisory — you cannot meaningfully withhold Delete from
-- somebody who can tick Delete.
--
-- So manage_permissions is its own column, and it is seeded onto whichever sets
-- already have administer. That is not a new restriction: an administrator can
-- change anybody's role today, which is the same power by a different route. It
-- is the ability to *narrow* it later that is new — untick manage_permissions
-- on the Administrator set and administrators keep Settings while the rules
-- themselves become somebody else's business.
--
-- THE TWO LOCKOUTS THIS REFUSES
--
-- Every write below ends by counting, across the whole organization, how many
-- active people still resolve to a set with administer, and how many with
-- manage_permissions. If either reaches zero the write is refused.
--
-- Both failures are unrecoverable from inside the app. Nobody with
-- manage_permissions means the rules can never be edited again; nobody with
-- administer means Settings is gone, and with it the screen that would fix it.
-- The counts are taken after the change, in the same transaction, so a refusal
-- takes the change with it.
--
-- WHY THESE ARE FUNCTIONS AND NOT POLICIES
--
-- The same reason invoice_lines has no write policy. A policy can say who may
-- write a row; it cannot say "and afterwards, somebody must still be able to
-- get back in". That is a question about the table as a whole after the write,
-- which is what a function that owns the write can ask and a row-level rule
-- cannot.
-- =============================================================================

alter table public.permission_sets
  add column if not exists manage_permissions boolean not null default false;

comment on column public.permission_sets.manage_permissions is
  'May edit permission sets and assign people to them. Deliberately not implied by administer.';

-- Whoever can already reach Settings can already change roles, so this grants
-- nothing that was not there this morning.
update public.permission_sets set manage_permissions = true where administer;

create or replace function public.seed_permission_sets(p_organization_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.permission_sets (
    organization_id, name, role,
    see_all_records, see_unassigned, write_records, delete_records,
    manage_records, bulk_records, administer, manage_permissions
  )
  values
    (p_organization_id, 'Administrator',  'admin',          true,  true,  true,  true,  true,  true,  true,  true),
    (p_organization_id, 'Manager',        'manager',        true,  true,  true,  true,  true,  true,  false, false),
    (p_organization_id, 'Sales director', 'sales_director', false, true,  true,  true,  false, true,  false, false),
    (p_organization_id, 'Sales rep',      'regular',        false, false, true,  true,  false, false, false, false),
    (p_organization_id, 'Read-only',      'readonly',       false, true,  false, false, false, false, false, false)
  on conflict do nothing;
$$;

create or replace function public.can_manage_permissions()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (public.current_permissions()).manage_permissions,
    -- The rule this replaced: an administrator could always change roles.
    public.current_user_role() = 'admin'
  );
$$;

comment on function public.can_manage_permissions() is
  'May edit permission sets. Separate from administer so Settings can be granted without the rulebook.';

revoke execute on function public.can_manage_permissions() from public, anon;
grant execute on function public.can_manage_permissions() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Who a set resolves for
--
-- The same rule current_permissions() applies to the caller, asked about
-- everybody: your own set if you have one, otherwise your role's. Used by the
-- delete guard and by the screen, which shows a count beside each set so the
-- consequence of editing one is visible before anybody edits it.
-- -----------------------------------------------------------------------------
create or replace function public.permission_set_members()
returns table (permission_set_id uuid, members bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ps.id, count(u.id)
  from public.permission_sets ps
  left join public.users u
    on u.organization_id = ps.organization_id
   and u.status = 'active'
   and (u.permission_set_id = ps.id or (u.permission_set_id is null and u.role = ps.role))
  where ps.organization_id = public.current_org_id()
  group by ps.id;
$$;

revoke execute on function public.permission_set_members() from public, anon;
grant execute on function public.permission_set_members() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The lockout guard
--
-- Counts, for one organization, how many active people still resolve to a set
-- carrying each of the two capabilities nobody can afford to lose. The final
-- coalesce arm mirrors the fallback inside the helpers, so an organization
-- running on the fallback is counted the same way it actually behaves.
-- -----------------------------------------------------------------------------
create or replace function public.assert_permissions_reachable(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admins   bigint;
  v_managers bigint;
begin
  select
    count(*) filter (where coalesce(own.administer, byrole.administer, u.role = 'admin')),
    count(*) filter (where coalesce(own.manage_permissions, byrole.manage_permissions, u.role = 'admin'))
  into v_admins, v_managers
  from public.users u
  left join public.permission_sets own
    on own.id = u.permission_set_id
  left join public.permission_sets byrole
    on byrole.organization_id = u.organization_id and byrole.role = u.role
  where u.organization_id = p_organization_id
    and u.status = 'active';

  if v_admins = 0 then
    raise exception 'That would leave nobody able to reach Settings. Give someone else Settings access first.';
  end if;

  if v_managers = 0 then
    raise exception 'That would leave nobody able to edit permissions, including you. Give someone else Manage permissions first.';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- The door
-- -----------------------------------------------------------------------------

create or replace function public.create_permission_set(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org  uuid := public.current_org_id();
  v_name text := btrim(coalesce(p_name, ''));
  v_id   uuid;
begin
  if not public.can_manage_permissions() then
    raise exception 'You do not have permission to edit permission sets';
  end if;

  if v_name = '' then
    raise exception 'A permission set needs a name';
  end if;

  -- Nothing ticked. A new set grants nothing until somebody says otherwise,
  -- which is the safe direction for a screen where the boxes are the point.
  insert into public.permission_sets (organization_id, name)
  values (v_org, v_name)
  returning id into v_id;

  return v_id;
exception when unique_violation then
  raise exception 'There is already a permission set called %', v_name;
end;
$$;

create or replace function public.update_permission_set(
  p_id                 uuid,
  p_name               text,
  p_see_all_records    boolean,
  p_see_unassigned     boolean,
  p_write_records      boolean,
  p_delete_records     boolean,
  p_manage_records     boolean,
  p_bulk_records       boolean,
  p_administer         boolean,
  p_manage_permissions boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org  uuid := public.current_org_id();
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.can_manage_permissions() then
    raise exception 'You do not have permission to edit permission sets';
  end if;

  if v_name = '' then
    raise exception 'A permission set needs a name';
  end if;

  update public.permission_sets set
    name               = v_name,
    see_all_records    = coalesce(p_see_all_records, false),
    see_unassigned     = coalesce(p_see_unassigned, false),
    write_records      = coalesce(p_write_records, false),
    delete_records     = coalesce(p_delete_records, false),
    manage_records     = coalesce(p_manage_records, false),
    bulk_records       = coalesce(p_bulk_records, false),
    administer         = coalesce(p_administer, false),
    manage_permissions = coalesce(p_manage_permissions, false)
  where id = p_id and organization_id = v_org;

  if not found then
    raise exception 'Permission set not found';
  end if;

  perform public.assert_permissions_reachable(v_org);
exception when unique_violation then
  raise exception 'There is already a permission set called %', v_name;
end;
$$;

/**
 * Deletes a set nobody is on.
 *
 * "Nobody is on it" includes people who resolve to it through their role
 * without having been assigned it, because users.permission_set_id is
 * `on delete set null` — deleting a set out from under somebody would drop them
 * to their role's set, or to the fallback, silently and with different
 * permissions. Refusing is the honest version of that.
 */
create or replace function public.delete_permission_set(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_members bigint;
begin
  if not public.can_manage_permissions() then
    raise exception 'You do not have permission to edit permission sets';
  end if;

  select m.members into v_members
  from public.permission_set_members() m
  where m.permission_set_id = p_id;

  if v_members is null then
    raise exception 'Permission set not found';
  end if;

  if v_members > 0 then
    raise exception 'This set still has % person/people on it. Move them to another set first.', v_members;
  end if;

  delete from public.permission_sets where id = p_id and organization_id = v_org;

  perform public.assert_permissions_reachable(v_org);
end;
$$;

/**
 * Puts somebody on a set, or takes them off it.
 *
 * Null means "resolve through your role again", which is where everybody starts
 * and where somebody goes back to if their set is later removed from them.
 */
create or replace function public.assign_permission_set(p_user_id uuid, p_set_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.can_manage_permissions() then
    raise exception 'You do not have permission to assign permission sets';
  end if;

  if p_set_id is not null and not exists (
    select 1 from public.permission_sets
    where id = p_set_id and organization_id = v_org
  ) then
    raise exception 'Permission set not found';
  end if;

  update public.users set permission_set_id = p_set_id
  where id = p_user_id and organization_id = v_org;

  if not found then
    raise exception 'User not found';
  end if;

  perform public.assert_permissions_reachable(v_org);
end;
$$;

revoke execute on function public.assert_permissions_reachable(uuid) from public, anon, authenticated;
revoke execute on function public.create_permission_set(text) from public, anon;
revoke execute on function public.update_permission_set(uuid, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon;
revoke execute on function public.delete_permission_set(uuid) from public, anon;
revoke execute on function public.assign_permission_set(uuid, uuid) from public, anon;

grant execute on function public.assert_permissions_reachable(uuid) to service_role;
grant execute on function public.create_permission_set(text) to authenticated, service_role;
grant execute on function public.update_permission_set(uuid, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to authenticated, service_role;
grant execute on function public.delete_permission_set(uuid) to authenticated, service_role;
grant execute on function public.assign_permission_set(uuid, uuid) to authenticated, service_role;
