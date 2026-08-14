-- =============================================================================
-- Hidden contacts and companies
--
-- Some records are nobody else's business. A contact being courted for
-- something the rest of the desk should not know about, a company whose
-- relationship is confidential. This adds a flag that takes a record out of
-- everybody's sight except the people who are allowed to see hidden things.
--
-- ONE CAPABILITY, NOT TWO
--
-- The obvious split is "may see hidden records" and "may hide records". It is
-- the wrong split. Somebody who can hide but not see would hide the wrong
-- contact, watch it vanish from their own screen, and have no way to find it
-- again, confirm it still exists, or put it back. That is not hiding; it is an
-- accidental delete with no undo.
--
-- So see_hidden is one box, and it grants both. Anybody who can hide something
-- can always find it again.
--
-- WHAT HIDDEN DOES NOT DO
--
-- It does not hide the record's deals, activities, invoices or sales orders. A
-- deal pointing at a hidden contact stays visible with a blank contact name:
-- the identity is gone, the existence is not. Cascading would mean six more
-- tables and a much larger blast radius, and it is not obviously right — the
-- deal is the desk's business even when the person behind it is not.
--
-- That is a real limit and it is written here rather than discovered later.
--
-- WHERE THE FLAG IS ENFORCED
--
-- Row-level security on the two tables is most of it, and the clause is the
-- same shape as the soft-delete clause already sitting beside it. But four
-- functions read contacts as SECURITY DEFINER and so go straight past those
-- policies. Three of them can leak:
--
--   build_campaign_audience      would email a hidden contact
--   build_campaign_audience_for  the same, from a list of ids
--   create_birthday_reminders    would raise a task naming one
--
-- All three are filtered below. contact_blocked_reason answers a yes/no about
-- deliverability for a contact id the caller already holds, and is only reached
-- through the audience builders, which no longer offer it hidden ones.
-- =============================================================================

alter table public.contacts
  add column if not exists hidden boolean not null default false,
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by uuid references public.users (id) on delete set null;

alter table public.companies
  add column if not exists hidden boolean not null default false,
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by uuid references public.users (id) on delete set null;

comment on column public.contacts.hidden is
  'Out of sight for everybody without see_hidden. Not a delete: the record is whole, and its deals stay visible.';
comment on column public.companies.hidden is
  'Out of sight for everybody without see_hidden. Not a delete: the record is whole, and its deals stay visible.';

-- Partial, because the interesting query is "show me the hidden ones" and the
-- hidden ones are the rare ones.
create index if not exists contacts_hidden_idx
  on public.contacts (organization_id) where hidden;
create index if not exists companies_hidden_idx
  on public.companies (organization_id) where hidden;

-- -----------------------------------------------------------------------------
-- The capability
--
-- Seeded onto the sets that can already edit permissions rather than onto every
-- administrator. Those are the people the request was about, and it is the
-- narrower of the two — a set can always be given it afterwards on the screen,
-- and taking it back from somebody who has already seen something is worth
-- less.
--
-- No behaviour changes either way today: nothing is hidden yet, so there is
-- nothing for the capability to reveal.
-- -----------------------------------------------------------------------------
alter table public.permission_sets
  add column if not exists see_hidden boolean not null default false;

comment on column public.permission_sets.see_hidden is
  'Sees hidden contacts and companies, and may hide or unhide them. One box, deliberately: see below.';

update public.permission_sets set see_hidden = true where manage_permissions;

create or replace function public.seed_permission_sets(p_organization_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.permission_sets (
    organization_id, name, role,
    see_all_records, see_unassigned, write_records, delete_records,
    manage_records, bulk_records, administer, manage_permissions, see_hidden
  )
  values
    (p_organization_id, 'Administrator',  'admin',          true,  true,  true,  true,  true,  true,  true,  true,  true),
    (p_organization_id, 'Manager',        'manager',        true,  true,  true,  true,  true,  true,  false, false, false),
    (p_organization_id, 'Sales director', 'sales_director', false, true,  true,  true,  false, true,  false, false, false),
    (p_organization_id, 'Sales rep',      'regular',        false, false, true,  true,  false, false, false, false, false),
    (p_organization_id, 'Read-only',      'readonly',       false, true,  false, false, false, false, false, false, false)
  on conflict do nothing;
$$;

/**
 * Sees hidden records, and may hide or unhide them.
 *
 * No fallback to a role, unlike the other helpers. Those exist so an
 * organization missing its seed degrades to what it did yesterday; yesterday
 * nothing could be hidden at all, so the honest degraded answer is false. A
 * fallback here would mean an organization with a broken seed silently showing
 * hidden records to every administrator.
 */
create or replace function public.can_see_hidden()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((public.current_permissions()).see_hidden, false);
$$;

revoke execute on function public.can_see_hidden() from public, anon;
grant execute on function public.can_see_hidden() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Who may move the flag
--
-- A trigger rather than a policy, because a policy decides whether a row may be
-- written at all and this is about one column. Somebody with write_records may
-- edit a hidden contact's phone number — they can see it, so of course they may
-- — but only see_hidden may change whether it is hidden.
--
-- Also stamps who and when, the same way contacts_stamp_actor already does.
-- -----------------------------------------------------------------------------
create or replace function public.records_guard_hidden()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  /*
   * Clearing the field in bulk arrives as null, and the column is not null.
   * Coercing here rather than rejecting it is also the right reading: "clear
   * hidden" means unhide, which is what somebody selecting a hundred contacts
   * and clearing the field intends. The comparison below then happens against
   * the coerced value, so clearing an already-visible record needs no
   * permission and unhiding a hidden one does.
   */
  new.hidden := coalesce(new.hidden, false);

  if tg_op = 'INSERT' then
    if new.hidden and not public.can_see_hidden() then
      raise exception 'You do not have permission to hide records';
    end if;
    if new.hidden then
      new.hidden_at := now();
      new.hidden_by := public.current_app_user_id();
    end if;
    return new;
  end if;

  if new.hidden is distinct from old.hidden then
    if not public.can_see_hidden() then
      raise exception 'You do not have permission to hide or unhide records';
    end if;
    new.hidden_at := case when new.hidden then now() end;
    new.hidden_by := case when new.hidden then public.current_app_user_id() end;
  else
    -- Not the caller's to set directly, either way.
    new.hidden_at := old.hidden_at;
    new.hidden_by := old.hidden_by;
  end if;

  return new;
end;
$$;

drop trigger if exists contacts_guard_hidden on public.contacts;
create trigger contacts_guard_hidden
  before insert or update on public.contacts
  for each row execute function public.records_guard_hidden();

drop trigger if exists companies_guard_hidden on public.companies;
create trigger companies_guard_hidden
  before insert or update on public.companies
  for each row execute function public.records_guard_hidden();

revoke execute on function public.records_guard_hidden() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- The policies
--
-- Recreated in full rather than patched, because a policy has no ALTER that
-- appends to its expression and a half-remembered rewrite is how a clause goes
-- missing. Every one of these is the policy as it stood after 20260230000000
-- with one clause added, in the same (select …) form so it stays an InitPlan.
--
-- Insert is left alone on purpose: the trigger above refuses a hidden insert
-- from somebody without the capability, and a row nobody can see is not created
-- by accident.
-- -----------------------------------------------------------------------------

drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts
  for select to authenticated
  using (((organization_id = (select public.current_org_id()))
    AND ((select public.can_see_all_records()) or owner_id = (select public.current_app_user_id()) or (owner_id is null and (select public.can_see_unassigned())))
    AND ((deleted_at IS NULL) OR (select public.is_org_admin()))
    AND ((hidden IS FALSE) OR (select public.can_see_hidden()))));

drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts
  for update to authenticated
  using (((organization_id = (select public.current_org_id()))
    AND (select public.can_write_records())
    AND ((select public.can_see_all_records()) or owner_id = (select public.current_app_user_id()) or (owner_id is null and (select public.can_see_unassigned())))
    AND ((deleted_at IS NULL) OR (select public.is_org_admin()))
    AND ((hidden IS FALSE) OR (select public.can_see_hidden()))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts
  for delete to authenticated
  using (((organization_id = (select public.current_org_id()))
    AND (select public.is_org_admin())
    AND ((hidden IS FALSE) OR (select public.can_see_hidden()))));

drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select to authenticated
  using (((organization_id = (select public.current_org_id()))
    AND ((deleted_at IS NULL) OR (select public.is_org_admin()))
    AND ((hidden IS FALSE) OR (select public.can_see_hidden()))));

drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies
  for update to authenticated
  using (((organization_id = (select public.current_org_id()))
    AND (select public.can_write_records())
    AND ((deleted_at IS NULL) OR (select public.is_org_admin()))
    AND ((hidden IS FALSE) OR (select public.can_see_hidden()))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists companies_delete on public.companies;
create policy companies_delete on public.companies
  for delete to authenticated
  using (((organization_id = (select public.current_org_id()))
    AND (select public.is_org_admin())
    AND ((hidden IS FALSE) OR (select public.can_see_hidden()))));

-- -----------------------------------------------------------------------------
-- The three that read past the policies
--
-- Each recreated with `and c.hidden is false` beside the deleted_at filter it
-- already had. A hidden contact stops being audience and stops generating
-- reminders, which is what hidden has to mean if it is to mean anything: a
-- record nobody can see should not send anybody an email in its own name.
-- -----------------------------------------------------------------------------

create or replace function public.build_campaign_audience(p_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign campaigns;
  v_count    integer;
begin
  select * into v_campaign from campaigns where id = p_campaign_id;
  if v_campaign.id is null then
    raise exception 'Campaign not found';
  end if;

  if public.current_org_id() is not null then
    if v_campaign.organization_id <> public.current_org_id() then
      raise exception 'Campaign not found';
    end if;
    if not public.can_manage_records() then
      raise exception 'Sending a campaign is a manager action';
    end if;
  end if;

  if v_campaign.list_id is null then
    raise exception 'A campaign needs a list before it has an audience';
  end if;

  insert into campaign_recipients
    (organization_id, campaign_id, contact_id, email, status, skip_reason)
  select
    c.organization_id,
    p_campaign_id,
    c.id,
    coalesce(c.email, ''),
    case when public.contact_blocked_reason(c.id) is null then 'pending' else 'skipped' end,
    public.contact_blocked_reason(c.id)
  from contacts c
  join email_list_members m on m.contact_id = c.id
  where m.list_id = v_campaign.list_id
    and c.organization_id = v_campaign.organization_id
    and c.deleted_at is null
    and c.duplicate_of_id is null
    -- A record nobody can see does not receive mail in its own name.
    and c.hidden is false
  on conflict (campaign_id, contact_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- The two below are their current definitions with one clause added. Taken
-- from pg_get_functiondef rather than retyped, so nothing else moved.

CREATE OR REPLACE FUNCTION public.build_campaign_audience_for(p_campaign_id uuid, p_contact_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_campaign campaigns%rowtype;
  v_count    integer;
begin
  select * into v_campaign from campaigns where id = p_campaign_id;
  if not found then
    raise exception 'Campaign not found';
  end if;

  -- Definer, so RLS is not doing the checking and this has to. Same guard as
  -- build_campaign_audience: own organization only, and only for somebody
  -- allowed to send. The drain has no session and is not restricted.
  if public.current_org_id() is not null then
    if v_campaign.organization_id <> public.current_org_id() then
      raise exception 'Campaign not found';
    end if;
    if not public.can_manage_records() then
      raise exception 'Sending a campaign is a manager action';
    end if;
  end if;

  -- Only while it is still a draft or scheduled. Adding recipients to a
  -- campaign that is already going out means somebody receives a message the
  -- person who approved it never saw being sent.
  if v_campaign.status not in ('draft', 'scheduled') then
    raise exception 'This campaign has already started sending';
  end if;

  if p_contact_ids is null or array_length(p_contact_ids, 1) is null then
    return 0;
  end if;

  insert into campaign_recipients
    (organization_id, campaign_id, contact_id, email, status, skip_reason)
  select
    c.organization_id,
    p_campaign_id,
    c.id,
    coalesce(c.email, ''),
    case when public.contact_blocked_reason(c.id) is null then 'pending' else 'skipped' end,
    public.contact_blocked_reason(c.id)
  from contacts c
  where c.id = any(p_contact_ids)
    -- The organization is re-checked against the campaign rather than trusted
    -- from the caller's ids: a definer function handed a list of uuids must
    -- assume they could be anybody's.
    and c.organization_id = v_campaign.organization_id
    and c.deleted_at is null
    and c.duplicate_of_id is null
    -- A record nobody can see does not receive mail in its own name.
    and c.hidden is false
  on conflict (campaign_id, contact_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

CREATE OR REPLACE FUNCTION public.create_birthday_reminders(p_days_ahead integer DEFAULT 3)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_created integer;
begin
  with due as (
    select
      c.id,
      c.organization_id,
      c.owner_id,
      trim(both ' ' from coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) as name,
      -- This year's occurrence, rolled forward if it has already passed, so the
      -- comparison works across a year boundary.
      (
        case
          when make_date(
                 extract(year from current_date)::int,
                 extract(month from c.birthday)::int,
                 extract(day from c.birthday)::int
               ) >= current_date
          then make_date(
                 extract(year from current_date)::int,
                 extract(month from c.birthday)::int,
                 extract(day from c.birthday)::int
               )
          else make_date(
                 extract(year from current_date)::int + 1,
                 extract(month from c.birthday)::int,
                 extract(day from c.birthday)::int
               )
        end
      ) as next_birthday
    from contacts c
    where c.birthday is not null
      and c.duplicate_of_id is null
      -- No reminder naming somebody the reader is not allowed to know about.
      and c.hidden is false
  )
  insert into activities (
    organization_id, type, related_to_type, related_to_id, owner_id,
    subject, body, due_date, external_source, external_id, occurred_at
  )
  select
    due.organization_id,
    'task',
    'contact',
    due.id,
    due.owner_id,
    'Birthday: ' || coalesce(nullif(due.name, ''), 'contact'),
    'Birthday on ' || to_char(due.next_birthday, 'FMMonth FMDD') || '.',
    due.next_birthday::timestamptz,
    'birthday',
    due.id::text || '-' || extract(year from due.next_birthday)::text,
    now()
  from due
  where due.next_birthday - current_date = p_days_ahead
  on conflict (organization_id, external_source, external_id) do nothing;

  get diagnostics v_created = row_count;
  return v_created;
end;
$function$;

revoke execute on function public.build_campaign_audience(uuid) from public, anon;
revoke execute on function public.build_campaign_audience_for(uuid, uuid[]) from public, anon;
revoke execute on function public.create_birthday_reminders(integer) from public, anon, authenticated;
grant execute on function public.build_campaign_audience(uuid) to authenticated, service_role;
grant execute on function public.build_campaign_audience_for(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.create_birthday_reminders(integer) to service_role;

-- -----------------------------------------------------------------------------
-- Hiding in bulk
--
-- The request was for a field that can be changed for many records at once,
-- which is what the flag is for: a handful of accounts going quiet together is
-- the ordinary case, not one at a time.
--
-- bulk_update_records reaches the column through its own whitelist, and the
-- trigger above still decides whether the caller may move it — so this widens
-- what can be edited in bulk without widening who can hide anything.
-- -----------------------------------------------------------------------------
do $$
declare v_def text;
begin
  -- pg_get_functiondef rather than prosrc: it carries the volatility, the
  -- security mode and the search_path with it. Rebuilding from the body alone
  -- silently made this SECURITY DEFINER on the first attempt, which would have
  -- handed every bulk edit the owner's rights and taken it past row-level
  -- security entirely. The tenant-isolation tests caught it. That is why the
  -- whole definition is taken here rather than only the part that changes.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'bulk_update_records';

  if v_def is null then
    raise exception 'bulk_update_records is missing — run the earlier migrations first';
  end if;

  if position('''hidden''' in v_def) > 0 then
    return;
  end if;

  -- Appended to the two scalar branches by the fields already in them, so this
  -- survives another field being added to either list in between.
  v_def := replace(v_def,
    '''owner_id'', ''company_id'', ''lifecycle_stage'', ''priority'', ''credibility''',
    '''owner_id'', ''company_id'', ''lifecycle_stage'', ''priority'', ''credibility'', ''hidden''');

  v_def := replace(v_def,
    'elsif p_entity = ''company'' and p_field = ''owner_id'' then',
    'elsif p_entity = ''company'' and p_field in (''owner_id'', ''hidden'') then');

  if position('''hidden''' in v_def) = 0 then
    raise exception 'Could not find the bulk field whitelist to extend';
  end if;

  execute v_def;
end;
$$;

-- -----------------------------------------------------------------------------
-- The screen writes this column too
--
-- update_permission_set is replaced rather than extended in place: a Postgres
-- function's signature is part of its identity, so adding a parameter creates a
-- second function rather than changing the first. The old one is dropped so
-- there is no stale ten-argument version left for something to call by mistake.
-- -----------------------------------------------------------------------------
drop function if exists public.update_permission_set(
  uuid, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean);

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
  p_manage_permissions boolean,
  p_see_hidden         boolean
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
    manage_permissions = coalesce(p_manage_permissions, false),
    see_hidden         = coalesce(p_see_hidden, false)
  where id = p_id and organization_id = v_org;

  if not found then
    raise exception 'Permission set not found';
  end if;

  perform public.assert_permissions_reachable(v_org);
exception when unique_violation then
  raise exception 'There is already a permission set called %', v_name;
end;
$$;

revoke execute on function public.update_permission_set(
  uuid, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean)
  from public, anon;
grant execute on function public.update_permission_set(
  uuid, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean)
  to authenticated, service_role;
