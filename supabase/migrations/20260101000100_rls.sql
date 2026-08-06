-- =============================================================================
-- FLO CRM — Row-level security (PRD Section 2, Section 10)
--
-- The application filters every query by organization_id as well. This file is
-- the second, independent layer: if application code ever forgets the filter,
-- Postgres still refuses to return another organization's rows.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Session helpers
--
-- security definer so they can read public.users without being subject to the
-- policies defined on public.users (which would recurse). search_path is pinned
-- so a caller cannot shadow the tables these functions read.
-- -----------------------------------------------------------------------------

-- Every organization the signed-in person belongs to.
create or replace function public.current_user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select organization_id
  from public.users
  where auth_provider_id = auth.uid()
    and status = 'active';
$$;

-- The one organization this session is bound to (PRD 6.1: exactly one).
--
-- Phase 1: a person has a single membership and this returns it. The
-- app_metadata claim is read first so Phase 3's "switch organization" is a
-- claim update rather than a schema change — and it is validated against real
-- membership, so a forged claim selects nothing.
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with claimed as (
    -- nullif before the cast: an absent or blank claims setting is normal for
    -- an unauthenticated request, and ''::jsonb raises.
    select nullif(
      coalesce(
        nullif(current_setting('request.jwt.claims', true), '')::jsonb
          -> 'app_metadata' ->> 'active_organization_id',
        ''
      ), ''
    )::uuid as id
  )
  select coalesce(
    (select c.id from claimed c
      where c.id is not null
        and exists (
          select 1 from public.users u
          where u.auth_provider_id = auth.uid()
            and u.status = 'active'
            and u.organization_id = c.id
        )),
    (select u.organization_id from public.users u
      where u.auth_provider_id = auth.uid()
        and u.status = 'active'
      order by u.created_at
      limit 1)
  );
$$;

-- The public.users row for this session.
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id
  from public.users
  where auth_provider_id = auth.uid()
    and status = 'active'
    and organization_id = public.current_org_id()
  limit 1;
$$;

create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.users
    where auth_provider_id = auth.uid()
      and status = 'active'
      and organization_id = public.current_org_id()
      and role = 'admin'
  );
$$;

revoke execute on function public.current_user_org_ids() from public;
revoke execute on function public.current_org_id() from public;
revoke execute on function public.current_app_user_id() from public;
revoke execute on function public.is_org_admin() from public;
grant execute on function public.current_user_org_ids() to authenticated, service_role;
grant execute on function public.current_org_id() to authenticated, service_role;
grant execute on function public.current_app_user_id() to authenticated, service_role;
grant execute on function public.is_org_admin() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere. Nothing in this schema is world-readable.
-- -----------------------------------------------------------------------------
alter table organizations           enable row level security;
alter table users                   enable row level security;
alter table contacts                enable row level security;
alter table companies               enable row level security;
alter table pipelines               enable row level security;
alter table stages                  enable row level security;
alter table deals                   enable row level security;
alter table activities              enable row level security;
alter table tags                    enable row level security;
alter table contact_tags            enable row level security;
alter table saved_filters           enable row level security;
alter table import_jobs             enable row level security;
alter table lead_score_rules        enable row level security;
alter table assignment_rules        enable row level security;
alter table custom_field_definitions enable row level security;

-- Force RLS for table owners too, so a migration-time role cannot silently
-- bypass the policies. (service_role holds BYPASSRLS and is unaffected — it is
-- only ever used by trusted server-side admin routes.)
alter table organizations           force row level security;
alter table users                   force row level security;
alter table contacts                force row level security;
alter table companies               force row level security;
alter table pipelines               force row level security;
alter table stages                  force row level security;
alter table deals                   force row level security;
alter table activities              force row level security;
alter table tags                    force row level security;
alter table contact_tags            force row level security;
alter table saved_filters           force row level security;
alter table import_jobs             force row level security;
alter table lead_score_rules        force row level security;
alter table assignment_rules        force row level security;
alter table custom_field_definitions force row level security;

-- -----------------------------------------------------------------------------
-- Organization: readable only to its own members. Creating an organization is
-- an internal admin action performed with the service role (PRD 1.3), so there
-- is deliberately no insert policy for authenticated users.
-- -----------------------------------------------------------------------------
create policy organizations_select on organizations
  for select to authenticated
  using (id in (select public.current_user_org_ids()));

create policy organizations_update on organizations
  for update to authenticated
  using (id = public.current_org_id() and public.is_org_admin())
  with check (id = public.current_org_id());

-- -----------------------------------------------------------------------------
-- Users: everyone in the organization can see their colleagues (needed for
-- owner pickers); only admins can change user records (PRD Section 4).
-- -----------------------------------------------------------------------------
create policy users_select on users
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy users_insert on users
  for insert to authenticated
  with check (organization_id = public.current_org_id() and public.is_org_admin());

create policy users_update on users
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and (public.is_org_admin() or id = public.current_app_user_id())
  )
  with check (organization_id = public.current_org_id());

create policy users_delete on users
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());

-- -----------------------------------------------------------------------------
-- Tenant data tables.
--
-- Phase 1 keeps record-level access simple: any member of the organization can
-- read and write the organization's records, ownership is tracked but not
-- restrictive. Phase 3 (8.4) is where field- and territory-level rules land;
-- they slot in by tightening these predicates, not by restructuring them.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'contacts', 'companies', 'pipelines', 'stages', 'deals', 'activities',
    'tags', 'contact_tags', 'import_jobs'
  ]
  loop
    execute format($p$
      create policy %1$s_select on %1$I
        for select to authenticated
        using (organization_id = public.current_org_id());

      create policy %1$s_insert on %1$I
        for insert to authenticated
        with check (organization_id = public.current_org_id());

      create policy %1$s_update on %1$I
        for update to authenticated
        using (organization_id = public.current_org_id())
        with check (organization_id = public.current_org_id());

      create policy %1$s_delete on %1$I
        for delete to authenticated
        using (organization_id = public.current_org_id());
    $p$, t);
  end loop;
end;
$$;

-- Configuration tables: everyone reads, admins write (PRD Section 4).
do $$
declare
  t text;
begin
  foreach t in array array[
    'lead_score_rules', 'assignment_rules', 'custom_field_definitions'
  ]
  loop
    execute format($p$
      create policy %1$s_select on %1$I
        for select to authenticated
        using (organization_id = public.current_org_id());

      create policy %1$s_write on %1$I
        for all to authenticated
        using (organization_id = public.current_org_id() and public.is_org_admin())
        with check (organization_id = public.current_org_id() and public.is_org_admin());
    $p$, t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Saved filters: shared filters are visible org-wide, private ones only to
-- their owner (acceptance criterion 6.6).
-- -----------------------------------------------------------------------------
create policy saved_filters_select on saved_filters
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and (is_shared or user_id = public.current_app_user_id())
  );

create policy saved_filters_insert on saved_filters
  for insert to authenticated
  with check (
    organization_id = public.current_org_id()
    and (user_id = public.current_app_user_id() or user_id is null)
  );

create policy saved_filters_update on saved_filters
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and (user_id = public.current_app_user_id() or public.is_org_admin())
  )
  with check (organization_id = public.current_org_id());

create policy saved_filters_delete on saved_filters
  for delete to authenticated
  using (
    organization_id = public.current_org_id()
    and (user_id = public.current_app_user_id() or public.is_org_admin())
  );

-- -----------------------------------------------------------------------------
-- Table privileges. RLS only filters rows that a role is already allowed to
-- touch; anon is allowed to touch nothing.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
