-- =============================================================================
-- Roles and record ownership
--
-- Until now the only boundary was the organization: every active user could
-- read, edit and delete every record in their own organization, and roles
-- governed nothing but the settings pages. This adds two boundaries inside the
-- organization:
--
--   * what a role may DO      — read, write, delete, import
--   * which records it may SEE — everything, or only what it owns
--
--   Admin     configuration, users, and every record
--   Manager   every record, no configuration
--   Regular   records they own (plus unassigned); no deleting, no importing
--   Readonly  looks, touches nothing
--
-- All of it lives in RLS rather than in the application. Supabase exposes a
-- REST API that any signed-in user can call with their own token, so a rule
-- enforced only in the UI is not a rule.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Role predicates
--
-- security definer, like is_org_admin(), so reading the caller's own role is
-- not itself subject to the policies being defined.
-- -----------------------------------------------------------------------------
create or replace function public.current_user_role()
returns user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role
  from public.users
  where auth_provider_id = auth.uid()
    and status = 'active'
    and organization_id = public.current_org_id()
  limit 1;
$$;

/** Admin or manager: sees every record and may delete. */
create or replace function public.can_manage_records()
returns boolean
language sql
stable
as $$
  select public.current_user_role() in ('admin', 'manager');
$$;

/** Anyone but a read-only user. A disabled or unprovisioned user is neither. */
create or replace function public.can_write_records()
returns boolean
language sql
stable
as $$
  select public.current_user_role() in ('admin', 'manager', 'regular');
$$;

/**
 * The visibility rule for owned records.
 *
 * Unassigned records stay visible to everyone on purpose: assignment routing
 * can leave owner_id null, and a lead nobody can see is a lead that gets lost.
 */
create or replace function public.can_see_owned(p_owner_id uuid)
returns boolean
language sql
stable
as $$
  select public.can_manage_records()
      or p_owner_id is null
      or p_owner_id = public.current_app_user_id();
$$;

revoke execute on function public.current_user_role() from public;
revoke execute on function public.can_manage_records() from public;
revoke execute on function public.can_write_records() from public;
revoke execute on function public.can_see_owned(uuid) from public;

grant execute on function public.current_user_role() to authenticated, service_role;
grant execute on function public.can_manage_records() to authenticated, service_role;
grant execute on function public.can_write_records() to authenticated, service_role;
grant execute on function public.can_see_owned(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Owned records: contacts and deals
--
-- A regular user sees only their own. Managers and admins see everything.
-- Deleting is a manager's job under every role.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['contacts', 'deals']
  loop
    execute format($p$
      drop policy if exists %1$s_select on %1$I;
      drop policy if exists %1$s_insert on %1$I;
      drop policy if exists %1$s_update on %1$I;
      drop policy if exists %1$s_delete on %1$I;

      create policy %1$s_select on %1$I
        for select to authenticated
        using (
          organization_id = public.current_org_id()
          and public.can_see_owned(owner_id)
        );

      create policy %1$s_insert on %1$I
        for insert to authenticated
        with check (
          organization_id = public.current_org_id()
          and public.can_write_records()
        );

      -- USING covers the row as it stands, so a regular user can only edit what
      -- they can already see. WITH CHECK deliberately does not re-test
      -- ownership: handing an account to a colleague is normal work, and you
      -- can only give away something you already had. The reverse — taking a
      -- colleague's record — is blocked by USING, which is the direction that
      -- matters.
      create policy %1$s_update on %1$I
        for update to authenticated
        using (
          organization_id = public.current_org_id()
          and public.can_write_records()
          and public.can_see_owned(owner_id)
        )
        with check (
          organization_id = public.current_org_id()
          and public.can_write_records()
        );

      create policy %1$s_delete on %1$I
        for delete to authenticated
        using (
          organization_id = public.current_org_id()
          and public.can_manage_records()
        );
    $p$, t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Shared records: companies
--
-- Deliberately visible to everyone. A rep whose contact works at a company they
-- cannot see would be looking at a broken record — and a company is not
-- confidential in the way a relationship is.
-- -----------------------------------------------------------------------------
drop policy if exists companies_select on companies;
drop policy if exists companies_insert on companies;
drop policy if exists companies_update on companies;
drop policy if exists companies_delete on companies;

create policy companies_select on companies
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy companies_insert on companies
  for insert to authenticated
  with check (organization_id = public.current_org_id() and public.can_write_records());

create policy companies_update on companies
  for update to authenticated
  using (organization_id = public.current_org_id() and public.can_write_records())
  with check (organization_id = public.current_org_id() and public.can_write_records());

create policy companies_delete on companies
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.can_manage_records());

-- -----------------------------------------------------------------------------
-- Activities follow the record they are attached to
--
-- The `exists` subqueries are subject to the policies just defined on contacts
-- and deals, so "the parent row is visible" is exactly "the subquery returns a
-- row" — the rule is stated once and cannot drift.
-- -----------------------------------------------------------------------------
drop policy if exists activities_select on activities;
drop policy if exists activities_insert on activities;
drop policy if exists activities_update on activities;
drop policy if exists activities_delete on activities;

create policy activities_select on activities
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and (
      public.can_manage_records()
      or owner_id = public.current_app_user_id()
      or related_to_type = 'company'
      or (related_to_type = 'contact'
          and exists (select 1 from contacts c where c.id = related_to_id))
      or (related_to_type = 'deal'
          and exists (select 1 from deals d where d.id = related_to_id))
    )
  );

create policy activities_insert on activities
  for insert to authenticated
  with check (organization_id = public.current_org_id() and public.can_write_records());

create policy activities_update on activities
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and (public.can_manage_records() or owner_id = public.current_app_user_id())
  )
  with check (organization_id = public.current_org_id() and public.can_write_records());

create policy activities_delete on activities
  for delete to authenticated
  using (
    organization_id = public.current_org_id()
    and (public.can_manage_records() or owner_id = public.current_app_user_id())
  );

-- -----------------------------------------------------------------------------
-- Tag links follow their record; tag definitions are shared vocabulary
-- -----------------------------------------------------------------------------
do $$
declare
  spec record;
begin
  for spec in
    select 'contact_tags' as t, 'contacts' as parent, 'contact_id' as fk
    union all
    select 'company_tags', 'companies', 'company_id'
  loop
    execute format($p$
      drop policy if exists %1$s_select on %1$I;
      drop policy if exists %1$s_insert on %1$I;
      drop policy if exists %1$s_update on %1$I;
      drop policy if exists %1$s_delete on %1$I;
      drop policy if exists %1$s_read on %1$I;
      drop policy if exists %1$s_write on %1$I;

      create policy %1$s_select on %1$I
        for select to authenticated
        using (
          organization_id = public.current_org_id()
          and exists (select 1 from %2$I p where p.id = %1$I.%3$I)
        );

      create policy %1$s_write on %1$I
        for all to authenticated
        using (
          organization_id = public.current_org_id()
          and public.can_write_records()
          and exists (select 1 from %2$I p where p.id = %1$I.%3$I)
        )
        with check (
          organization_id = public.current_org_id()
          and public.can_write_records()
        );
    $p$, spec.t, spec.parent, spec.fk);
  end loop;
end;
$$;

-- Tags themselves: everyone reads, anyone who can write may create, only a
-- manager may remove one — deleting a tag strips it from every record.
drop policy if exists tags_select on tags;
drop policy if exists tags_insert on tags;
drop policy if exists tags_update on tags;
drop policy if exists tags_delete on tags;

create policy tags_select on tags
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy tags_insert on tags
  for insert to authenticated
  with check (organization_id = public.current_org_id() and public.can_write_records());

create policy tags_update on tags
  for update to authenticated
  using (organization_id = public.current_org_id() and public.can_manage_records())
  with check (organization_id = public.current_org_id() and public.can_manage_records());

create policy tags_delete on tags
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.can_manage_records());

-- -----------------------------------------------------------------------------
-- Structure: pipelines and stages are everyone's to read, an admin's to change
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['pipelines', 'stages']
  loop
    execute format($p$
      drop policy if exists %1$s_select on %1$I;
      drop policy if exists %1$s_insert on %1$I;
      drop policy if exists %1$s_update on %1$I;
      drop policy if exists %1$s_delete on %1$I;

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
-- Bulk import is a manager's tool
--
-- An import writes hundreds of records at once and is the easiest way to make a
-- mess that is hard to undo.
-- -----------------------------------------------------------------------------
drop policy if exists import_jobs_select on import_jobs;
drop policy if exists import_jobs_insert on import_jobs;
drop policy if exists import_jobs_update on import_jobs;
drop policy if exists import_jobs_delete on import_jobs;

create policy import_jobs_select on import_jobs
  for select to authenticated
  using (organization_id = public.current_org_id() and public.can_manage_records());

create policy import_jobs_write on import_jobs
  for all to authenticated
  using (organization_id = public.current_org_id() and public.can_manage_records())
  with check (organization_id = public.current_org_id() and public.can_manage_records());

-- -----------------------------------------------------------------------------
-- Configuration written since the original RLS migration
--
-- field_options checked only the organization: the settings page required an
-- admin but the REST API did not, so the rule was never actually enforced.
-- It now matches its sibling configuration tables.
-- -----------------------------------------------------------------------------
drop policy if exists field_options_read on field_options;
drop policy if exists field_options_write on field_options;

create policy field_options_read on field_options
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy field_options_write on field_options
  for all to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin())
  with check (organization_id = public.current_org_id() and public.is_org_admin());

-- -----------------------------------------------------------------------------
-- Handing a record to a colleague
--
-- Ownership scoping and self-service handoff conflict in plain SQL: under FORCE
-- ROW LEVEL SECURITY, PostgreSQL requires an updated row to still satisfy the
-- SELECT policy, and the moment a rep sets owner_id to a colleague the row
-- stops being visible to them. The write is refused — even with `with check
-- (true)` — so no arrangement of policies fixes it.
--
-- These functions do the authorisation themselves and then perform the write
-- with definer rights. The rule they enforce is the honest one: you may give
-- away a record you can currently see, and that is all. Taking someone else's
-- is impossible because you cannot see it to name it.
-- -----------------------------------------------------------------------------
create or replace function public.reassign_contact(p_contact_id uuid, p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_visible boolean;
begin
  if not public.can_write_records() then
    raise exception 'You do not have permission to reassign records';
  end if;

  -- Deliberately evaluated through the caller's own visibility rule rather
  -- than by reading the row directly, so this function cannot become a way to
  -- reach a record the policies hide.
  select public.can_see_owned(owner_id) into v_visible
  from public.contacts
  where id = p_contact_id and organization_id = v_org;

  if v_visible is not true then
    raise exception 'Contact not found';
  end if;

  if p_new_owner_id is not null and not exists (
    select 1 from public.users
    where id = p_new_owner_id and organization_id = v_org and status = 'active'
  ) then
    raise exception 'The new owner must be an active user in this organization';
  end if;

  update public.contacts
  set owner_id = p_new_owner_id
  where id = p_contact_id and organization_id = v_org;
end;
$$;

create or replace function public.reassign_deal(p_deal_id uuid, p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_visible boolean;
begin
  if not public.can_write_records() then
    raise exception 'You do not have permission to reassign records';
  end if;

  select public.can_see_owned(owner_id) into v_visible
  from public.deals
  where id = p_deal_id and organization_id = v_org;

  if v_visible is not true then
    raise exception 'Deal not found';
  end if;

  if p_new_owner_id is not null and not exists (
    select 1 from public.users
    where id = p_new_owner_id and organization_id = v_org and status = 'active'
  ) then
    raise exception 'The new owner must be an active user in this organization';
  end if;

  update public.deals
  set owner_id = p_new_owner_id
  where id = p_deal_id and organization_id = v_org;
end;
$$;

revoke execute on function public.reassign_contact(uuid, uuid) from public;
revoke execute on function public.reassign_deal(uuid, uuid) from public;
grant execute on function public.reassign_contact(uuid, uuid) to authenticated, service_role;
grant execute on function public.reassign_deal(uuid, uuid) to authenticated, service_role;
