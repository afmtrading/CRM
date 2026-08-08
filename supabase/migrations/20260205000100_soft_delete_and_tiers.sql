-- =============================================================================
-- Sales tiers, soft delete, and deletion notices
--
-- Three changes that belong together, because they all turn on who may see
-- what:
--
--   1. A second sales tier. A Sales Director works their own book plus
--      unassigned leads and can import, export and reassign; a Sales Rep sees
--      only what they own and none of those tools.
--
--   2. Deleting a contact or company no longer destroys it. The row is stamped
--      and disappears from everyone's view except an administrator's, who can
--      put it back.
--
--   3. Every deletion raises a notice for the administrators, so a record does
--      not quietly vanish.
--
--   Admin           everything, including deleted records and settings
--   Manager         every live record; delete, import, export, reassign
--   Sales director  own + unassigned; delete, import, export, reassign
--   Sales rep       own only; create, edit, delete
--   Read-only       reads, writes nothing
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Soft delete
-- -----------------------------------------------------------------------------
alter table contacts
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references users (id) on delete set null;

alter table companies
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references users (id) on delete set null;

-- Partial indexes: the common query wants live rows, the recycle bin wants the
-- few deleted ones.
create index if not exists contacts_live_idx
  on contacts (organization_id) where deleted_at is null;
create index if not exists companies_live_idx
  on companies (organization_id) where deleted_at is null;
create index if not exists contacts_deleted_idx
  on contacts (organization_id, deleted_at desc) where deleted_at is not null;
create index if not exists companies_deleted_idx
  on companies (organization_id, deleted_at desc) where deleted_at is not null;

-- -----------------------------------------------------------------------------
-- Notifications
--
-- Deliberately minimal: a row per recipient, marked read when they have seen
-- it. Deletion is the first thing that raises one, but nothing here is specific
-- to deletion.
-- -----------------------------------------------------------------------------
create table if not exists notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id         uuid not null references users (id) on delete cascade,
  kind            text not null,
  title           text not null,
  body            text,
  /** Where to go when the notice is clicked. Relative to the app root. */
  link            text,
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists notifications_inbox_idx
  on notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx
  on notifications (user_id) where read_at is null;

revoke all on notifications from anon;
grant select, insert, update, delete on notifications to authenticated;

alter table notifications enable row level security;
alter table notifications force row level security;

-- A notification is addressed to one person, and only that person reads it.
drop policy if exists notifications_select on notifications;
create policy notifications_select on notifications
  for select to authenticated
  using (organization_id = public.current_org_id() and user_id = public.current_app_user_id());

drop policy if exists notifications_update on notifications;
create policy notifications_update on notifications
  for update to authenticated
  using (organization_id = public.current_org_id() and user_id = public.current_app_user_id())
  with check (organization_id = public.current_org_id() and user_id = public.current_app_user_id());

drop policy if exists notifications_delete on notifications;
create policy notifications_delete on notifications
  for delete to authenticated
  using (organization_id = public.current_org_id() and user_id = public.current_app_user_id());

-- Nobody writes their own notifications; they arrive from definer functions.
drop policy if exists notifications_insert on notifications;

-- -----------------------------------------------------------------------------
-- Role predicates
-- -----------------------------------------------------------------------------

/** Admin and manager see the whole organization's live records. */
create or replace function public.can_see_all_records()
returns boolean
language sql
stable
as $$
  select public.current_user_role() in ('admin', 'manager');
$$;

/**
 * Who may work the unassigned pool.
 *
 * A Sales Rep is deliberately excluded: their book is theirs alone. That means
 * an unassigned lead is invisible to reps, so assignment routing has to place
 * new leads — see the note on next_assignee in the functions migration.
 */
create or replace function public.can_see_unassigned()
returns boolean
language sql
stable
as $$
  select public.current_user_role() in ('admin', 'manager', 'sales_director', 'readonly');
$$;

/** Import, export, and reassigning a record to someone else. */
create or replace function public.can_bulk_records()
returns boolean
language sql
stable
as $$
  select public.current_user_role() in ('admin', 'manager', 'sales_director');
$$;

create or replace function public.can_write_records()
returns boolean
language sql
stable
as $$
  select public.current_user_role() in ('admin', 'manager', 'sales_director', 'regular');
$$;

/** Everyone who may write may also delete — deletion is now reversible. */
create or replace function public.can_delete_records()
returns boolean
language sql
stable
as $$
  select public.can_write_records();
$$;

/** Kept for compatibility: "sees everything and runs the bulk tools". */
create or replace function public.can_manage_records()
returns boolean
language sql
stable
as $$
  select public.can_see_all_records();
$$;

create or replace function public.can_see_owned(p_owner_id uuid)
returns boolean
language sql
stable
as $$
  select public.can_see_all_records()
      or p_owner_id = public.current_app_user_id()
      or (p_owner_id is null and public.can_see_unassigned());
$$;

revoke execute on function public.can_see_all_records() from public;
revoke execute on function public.can_see_unassigned() from public;
revoke execute on function public.can_bulk_records() from public;
revoke execute on function public.can_delete_records() from public;
grant execute on function public.can_see_all_records() to authenticated, service_role;
grant execute on function public.can_see_unassigned() to authenticated, service_role;
grant execute on function public.can_bulk_records() to authenticated, service_role;
grant execute on function public.can_delete_records() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Contacts and companies: deleted rows are an administrator's business
--
-- The visibility rule now has two halves — is this record mine to see, and has
-- it been deleted. Only an admin passes the second one once deleted_at is set.
-- -----------------------------------------------------------------------------
drop policy if exists contacts_select on contacts;
create policy contacts_select on contacts
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_see_owned(owner_id)
    and (deleted_at is null or public.is_org_admin())
  );

drop policy if exists contacts_update on contacts;
create policy contacts_update on contacts
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and public.can_see_owned(owner_id)
    and (deleted_at is null or public.is_org_admin())
  )
  with check (organization_id = public.current_org_id() and public.can_write_records());

-- A hard delete is reserved for administrators emptying the bin for good.
drop policy if exists contacts_delete on contacts;
create policy contacts_delete on contacts
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());

drop policy if exists companies_select on companies;
create policy companies_select on companies
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and (deleted_at is null or public.is_org_admin())
  );

drop policy if exists companies_delete on companies;
create policy companies_delete on companies
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());

drop policy if exists companies_update on companies;
create policy companies_update on companies
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and (deleted_at is null or public.is_org_admin())
  )
  with check (organization_id = public.current_org_id() and public.can_write_records());

-- Import stays with the bulk roles rather than with managers alone.
drop policy if exists import_jobs_select on import_jobs;
drop policy if exists import_jobs_write on import_jobs;

create policy import_jobs_select on import_jobs
  for select to authenticated
  using (organization_id = public.current_org_id() and public.can_bulk_records());

create policy import_jobs_write on import_jobs
  for all to authenticated
  using (organization_id = public.current_org_id() and public.can_bulk_records())
  with check (organization_id = public.current_org_id() and public.can_bulk_records());

-- -----------------------------------------------------------------------------
-- Deleting, restoring, and telling the administrators
--
-- Definer functions for the same reason reassignment needs one: under FORCE ROW
-- LEVEL SECURITY an updated row must still satisfy the SELECT policy, and a row
-- that has just been marked deleted fails it for everyone but an admin. A plain
-- UPDATE would be refused.
-- -----------------------------------------------------------------------------
create or replace function public.notify_admins(
  p_org uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_link text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.notifications (organization_id, user_id, kind, title, body, link)
  select p_org, u.id, p_kind, p_title, p_body, p_link
  from public.users u
  where u.organization_id = p_org
    and u.role = 'admin'
    and u.status = 'active';
$$;

create or replace function public.soft_delete_contact(p_contact_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_actor   uuid := public.current_app_user_id();
  v_visible boolean;
  v_name    text;
begin
  if not public.can_delete_records() then
    raise exception 'Your role does not allow deleting records';
  end if;

  select public.can_see_owned(owner_id),
         trim(both ' ' from coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
  into v_visible, v_name
  from public.contacts
  where id = p_contact_id and organization_id = v_org and deleted_at is null;

  if v_visible is not true then
    raise exception 'Contact not found';
  end if;

  update public.contacts
  set deleted_at = now(), deleted_by = v_actor
  where id = p_contact_id and organization_id = v_org;

  perform public.notify_admins(
    v_org,
    'contact_deleted',
    'Contact deleted: ' || coalesce(nullif(v_name, ''), 'unnamed contact'),
    coalesce((select name || ' (' || email || ')' from public.users where id = v_actor), 'Someone')
      || ' deleted this contact. It can still be restored.',
    '/settings/deleted'
  );
end;
$$;

create or replace function public.soft_delete_company(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   uuid := public.current_org_id();
  v_actor uuid := public.current_app_user_id();
  v_name  text;
begin
  if not public.can_delete_records() then
    raise exception 'Your role does not allow deleting records';
  end if;

  select name into v_name
  from public.companies
  where id = p_company_id and organization_id = v_org and deleted_at is null;

  if v_name is null then
    raise exception 'Company not found';
  end if;

  update public.companies
  set deleted_at = now(), deleted_by = v_actor
  where id = p_company_id and organization_id = v_org;

  perform public.notify_admins(
    v_org,
    'company_deleted',
    'Company deleted: ' || v_name,
    coalesce((select name || ' (' || email || ')' from public.users where id = v_actor), 'Someone')
      || ' deleted this company. It can still be restored.',
    '/settings/deleted'
  );
end;
$$;

/** Restoring is an administrator's job, being the only role that sees the bin. */
create or replace function public.restore_contact(p_contact_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can restore a record';
  end if;

  update public.contacts
  set deleted_at = null, deleted_by = null
  where id = p_contact_id and organization_id = public.current_org_id();
end;
$$;

create or replace function public.restore_company(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can restore a record';
  end if;

  update public.companies
  set deleted_at = null, deleted_by = null
  where id = p_company_id and organization_id = public.current_org_id();
end;
$$;

revoke execute on function public.notify_admins(uuid, text, text, text, text) from public;
revoke execute on function public.soft_delete_contact(uuid) from public;
revoke execute on function public.soft_delete_company(uuid) from public;
revoke execute on function public.restore_contact(uuid) from public;
revoke execute on function public.restore_company(uuid) from public;

grant execute on function public.soft_delete_contact(uuid) to authenticated, service_role;
grant execute on function public.soft_delete_company(uuid) to authenticated, service_role;
grant execute on function public.restore_contact(uuid) to authenticated, service_role;
grant execute on function public.restore_company(uuid) to authenticated, service_role;
grant execute on function public.notify_admins(uuid, text, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- Reassignment follows the bulk roles
--
-- A Sales Rep no longer hands records over: they cannot see the unassigned pool
-- and are not meant to move work around. A Sales Director can.
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
  if not public.can_bulk_records() then
    raise exception 'Your role does not allow assigning records';
  end if;

  select public.can_see_owned(owner_id) into v_visible
  from public.contacts
  where id = p_contact_id and organization_id = v_org and deleted_at is null;

  if v_visible is not true then
    raise exception 'Contact not found';
  end if;

  if p_new_owner_id is not null and not exists (
    select 1 from public.users
    where id = p_new_owner_id and organization_id = v_org and status = 'active'
  ) then
    raise exception 'The new owner must be an active user in this organization';
  end if;

  update public.contacts set owner_id = p_new_owner_id
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
  if not public.can_bulk_records() then
    raise exception 'Your role does not allow assigning records';
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

  update public.deals set owner_id = p_new_owner_id
  where id = p_deal_id and organization_id = v_org;
end;
$$;

-- -----------------------------------------------------------------------------
-- Deleted records stay out of the working set
--
-- find_duplicate_contacts and the pipeline report both read contacts directly;
-- a deleted record must not come back as a merge suggestion or a number in a
-- total. RLS hides them from everyone but an admin, and for an admin the filter
-- below is what keeps them out.
-- -----------------------------------------------------------------------------
create or replace function public.find_duplicate_contacts(
  p_email      text default null,
  p_first_name text default null,
  p_last_name  text default null,
  p_phone      text default null,
  p_exclude_id uuid default null
)
returns setof contacts
language sql
stable
as $$
  select c.*
  from contacts c
  where c.organization_id = public.current_org_id()
    and c.duplicate_of_id is null
    and c.deleted_at is null
    and (p_exclude_id is null or c.id <> p_exclude_id)
    and (
      (p_email is not null and p_email <> '' and lower(c.email) = lower(p_email))
      or (
        p_phone is not null and p_phone <> ''
        and public.normalize_phone(c.phone) = public.normalize_phone(p_phone)
        and public.normalize_phone(p_phone) <> ''
      )
      or (
        p_first_name is not null and p_first_name <> ''
        and p_last_name is not null and p_last_name <> ''
        and lower(c.first_name) = lower(p_first_name)
        and lower(c.last_name) = lower(p_last_name)
      )
    );
$$;
