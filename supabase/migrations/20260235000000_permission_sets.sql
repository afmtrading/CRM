-- =============================================================================
-- Permissions become data
--
-- WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
--
-- Nobody's access changes. Not one person, in either organization. That is the
-- whole point of this migration and the test file that goes with it: it moves
-- where the answer comes from without changing a single answer.
--
-- THE SHAPE TODAY
--
-- Roughly a hundred row-level policies never ask what role somebody has. They
-- ask capability questions — can_see_all_records(), can_write_records(),
-- can_bulk_records() and five more. The role enum only appears inside those
-- eight functions, as a hardcoded list:
--
--   create function public.can_see_all_records() ... as $$
--     select public.current_user_role() in ('admin', 'manager');
--   $$;
--
-- So the capability layer already exists and is already the thing the database
-- enforces. What is hardcoded is one line per capability: which roles get it.
--
-- THE SHAPE AFTER THIS
--
-- That line becomes a row. A permission set is a named bundle of capabilities
-- belonging to an organization, and the eight functions read the caller's set
-- instead of a literal list. The policies are untouched — they go on calling
-- the same eight functions, which go on returning the same booleans.
--
-- Five sets are seeded per organization, one per existing role, with exactly
-- the capabilities that role has today. Users are not reassigned: they resolve
-- to a set through the role they already have. So on the day this ships the
-- system computes the same answers by a longer route, and nothing else.
--
-- WHY users.permission_set_id EXISTS ALREADY AND IS NULL FOR EVERYONE
--
-- Because the next step is naming sets freely — "Ops", "Read-only auditor" —
-- rather than being stuck with five. A user's own set wins when it is set, and
-- the role-matched one answers when it is not. Adding the column now means the
-- step that introduces the screen is a screen and nothing else: no second
-- migration, no second chance to get the mapping wrong.
--
-- WHY EVERY CAPABILITY GETS ITS OWN COLUMN EVEN WHERE TWO ARE ALIASES
--
-- can_manage_records() is defined as can_see_all_records() today, and
-- can_delete_records() as can_write_records(). Two pairs, four names. Seeding
-- them as four independent columns with equal values keeps today's behaviour
-- exactly and makes "may edit but may not delete" expressible tomorrow by
-- unticking a box rather than by writing another migration. That combination
-- is one of the things the sets are for.
--
-- THE FALLBACK, WHICH SHOULD NEVER FIRE
--
-- Every helper below reads its column and falls back to the old hardcoded rule
-- when no set resolves at all. An organization with no permission sets would
-- otherwise leave everyone with nothing — including its administrators, who
-- would then be unable to fix it. The seed and the trigger below should make
-- that impossible; the fallback is there because "should" is not "cannot", and
-- a lockout is not a recoverable failure.
-- =============================================================================

create table if not exists public.permission_sets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null,

  /**
   * Which legacy role resolves to this set when a user has no set of their own.
   * Null for a set somebody made up, which nothing resolves to by role.
   */
  role            user_role,

  /** Every record in the organization, not just your own. */
  see_all_records boolean not null default false,
  /** Records with no owner. Assignment routing can leave owner_id null, and a
      lead nobody can see is a lead that gets lost. */
  see_unassigned  boolean not null default false,
  /** Create and edit. */
  write_records   boolean not null default false,
  /** Delete — which in this app means to the recycle bin. */
  delete_records  boolean not null default false,
  /** Reassign an owner, and reach records through the manage-level policies. */
  manage_records  boolean not null default false,
  /** Bulk edit, import and export. */
  bulk_records    boolean not null default false,
  /** Settings, users, and the recycle bin. The keys to the building. */
  administer      boolean not null default false,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One set per role per organization, so the role fallback below can never be
-- ambiguous. Partial, because freely named sets have no role at all.
create unique index if not exists permission_sets_org_role
  on public.permission_sets (organization_id, role) where role is not null;

create unique index if not exists permission_sets_org_name
  on public.permission_sets (organization_id, lower(name));

create index if not exists permission_sets_org_idx
  on public.permission_sets (organization_id);

drop trigger if exists permission_sets_updated_at on public.permission_sets;
create trigger permission_sets_updated_at
  before update on public.permission_sets
  for each row execute function public.set_updated_at();

alter table public.users
  add column if not exists permission_set_id uuid
  references public.permission_sets (id) on delete set null;

comment on column public.users.permission_set_id is
  'The set this person is on. Null resolves through their role instead — see current_permissions().';

-- -----------------------------------------------------------------------------
-- Seeding
--
-- The values below are not a design. They are a transcription of what the eight
-- functions return today, and the test file asserts every cell of it:
--
--   see_all_records  admin, manager
--   see_unassigned   admin, manager, sales_director, readonly
--   write_records    admin, manager, sales_director, regular
--   delete_records   = write_records
--   manage_records   = see_all_records
--   bulk_records     admin, manager, sales_director
--   administer       admin
--
-- Read-only seeing unassigned records but a sales rep not is not a mistake here
-- — it is what the app does today, and correcting it is a decision for a
-- screen, not for a migration whose job is to change nothing.
-- -----------------------------------------------------------------------------
create or replace function public.seed_permission_sets(p_organization_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.permission_sets (
    organization_id, name, role,
    see_all_records, see_unassigned, write_records, delete_records,
    manage_records, bulk_records, administer
  )
  values
    (p_organization_id, 'Administrator',  'admin',          true,  true,  true,  true,  true,  true,  true),
    (p_organization_id, 'Manager',        'manager',        true,  true,  true,  true,  true,  true,  false),
    (p_organization_id, 'Sales director', 'sales_director', false, true,  true,  true,  false, true,  false),
    (p_organization_id, 'Sales rep',      'regular',        false, false, true,  true,  false, false, false),
    (p_organization_id, 'Read-only',      'readonly',       false, true,  false, false, false, false, false)
  on conflict do nothing;
$$;

comment on function public.seed_permission_sets(uuid) is
  'The five sets an organization starts with, matching the five roles exactly.';

-- Every organization that exists now.
do $$
declare v_org uuid;
begin
  for v_org in select id from public.organizations loop
    perform public.seed_permission_sets(v_org);
  end loop;
end;
$$;

-- And every organization made from here on. Without this a new organization
-- would have no sets at all, and every one of its users would fall through to
-- the fallback — which works, but silently, and would hide the omission until
-- somebody edited a set and wondered why nothing happened.
create or replace function public.organizations_seed_permission_sets()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.seed_permission_sets(new.id);
  return new;
end;
$$;

drop trigger if exists organizations_seed_permission_sets on public.organizations;
create trigger organizations_seed_permission_sets
  after insert on public.organizations
  for each row execute function public.organizations_seed_permission_sets();

-- -----------------------------------------------------------------------------
-- Resolving the caller's set
--
-- SECURITY DEFINER, like current_user_role() before it: reading which
-- permissions you have cannot itself be subject to the policies those
-- permissions decide, or the question never terminates.
--
-- The join says "your own set if you have one, otherwise the one matching your
-- role". Both branches are constrained to your own organization, so a set id
-- belonging to somebody else's organization resolves to nothing rather than to
-- their permissions.
-- -----------------------------------------------------------------------------
create or replace function public.current_permissions()
returns public.permission_sets
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ps.*
  from public.users u
  join public.permission_sets ps
    on ps.organization_id = u.organization_id
   and (
     ps.id = u.permission_set_id
     or (u.permission_set_id is null and ps.role = u.role)
   )
  where u.auth_provider_id = auth.uid()
    and u.status = 'active'
    and u.organization_id = public.current_org_id()
  limit 1;
$$;

comment on function public.current_permissions() is
  'The caller''s permission set: their own if assigned, otherwise their role''s.';

-- -----------------------------------------------------------------------------
-- The eight, rewritten
--
-- Same names, same signatures, same STABLE / non-definer shape, same pinned
-- search_path — so the policies calling them behave identically and the
-- (select …) wrapper at every call site still hoists them to a single InitPlan
-- per query. Only the source of the boolean has moved.
-- -----------------------------------------------------------------------------

create or replace function public.can_see_all_records()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (public.current_permissions()).see_all_records,
    -- No set resolved. The rule this replaced, so an organization missing its
    -- seed degrades to yesterday rather than to nothing.
    public.current_user_role() in ('admin', 'manager')
  );
$$;

create or replace function public.can_see_unassigned()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (public.current_permissions()).see_unassigned,
    public.current_user_role() in ('admin', 'manager', 'sales_director', 'readonly')
  );
$$;

create or replace function public.can_write_records()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (public.current_permissions()).write_records,
    public.current_user_role() in ('admin', 'manager', 'sales_director', 'regular')
  );
$$;

create or replace function public.can_delete_records()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (public.current_permissions()).delete_records,
    public.current_user_role() in ('admin', 'manager', 'sales_director', 'regular')
  );
$$;

create or replace function public.can_manage_records()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (public.current_permissions()).manage_records,
    public.current_user_role() in ('admin', 'manager')
  );
$$;

create or replace function public.can_bulk_records()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (public.current_permissions()).bulk_records,
    public.current_user_role() in ('admin', 'manager', 'sales_director')
  );
$$;

/**
 * Settings, users and the recycle bin.
 *
 * Kept SECURITY DEFINER as it was, because the fallback reads users directly
 * rather than going through current_user_role().
 */
create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (public.current_permissions()).administer,
    exists (
      select 1
      from public.users
      where auth_provider_id = auth.uid()
        and status = 'active'
        and organization_id = public.current_org_id()
        and role = 'admin'
    )
  );
$$;

/**
 * Unchanged in meaning, and restated here only because it is built from two of
 * the functions above and reads better next to them than three migrations away.
 */
create or replace function public.can_see_owned(p_owner_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public.can_see_all_records()
      or p_owner_id = public.current_app_user_id()
      or (p_owner_id is null and public.can_see_unassigned());
$$;

-- -----------------------------------------------------------------------------
-- Who may read a set
--
-- Everybody in the organization, because the app has to be able to say what a
-- colleague's access is on the Users screen, and because the set is not secret
-- — it is the rules of the building.
--
-- Nobody may write one yet. Editing arrives with the screen that edits it, and
-- a table that can be changed before anything can show the change is a table
-- that gets changed by accident.
-- -----------------------------------------------------------------------------
alter table public.permission_sets enable row level security;
alter table public.permission_sets force row level security;

drop policy if exists permission_sets_select on public.permission_sets;
create policy permission_sets_select on public.permission_sets
  for select to authenticated
  using (organization_id = (select public.current_org_id()));

revoke all on public.permission_sets from public, anon;
grant select on public.permission_sets to authenticated;
grant select, insert, update, delete on public.permission_sets to service_role;

revoke execute on function public.current_permissions() from public, anon;
revoke execute on function public.seed_permission_sets(uuid) from public, anon, authenticated;
revoke execute on function public.organizations_seed_permission_sets() from public, anon, authenticated;

grant execute on function public.current_permissions() to authenticated, service_role;
grant execute on function public.seed_permission_sets(uuid) to service_role;
