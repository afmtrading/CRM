-- =============================================================================
-- Consent, suppression, and lists — the groundwork under mass email
--
-- Nothing here sends anything. It is the part that has to exist first, because
-- the question "may we email this person, and can we show why" is one you can
-- only answer with records you kept at the time.
--
-- Canadian law is the strict case and therefore the one to build for. It works
-- on consent given *before* sending rather than an opt-out afterwards, and it
-- distinguishes express consent — somebody actively agreed — from implied,
-- which arises from a real business relationship and then expires. So a
-- contact carries not just a flag but a provenance: what kind of consent, from
-- where, and when. A flag alone is not defensible a year later.
--
-- Three things get added:
--
--   * consent on a contact, with its source and date;
--   * a suppression list keyed on the *address* rather than the contact,
--     because one person may hold two records and an unsubscribe must stop
--     both;
--   * lists — a saved audience, either an explicit set of people or a saved
--     filter that re-reads itself at send time.
-- =============================================================================

do $$
begin
  if to_regprocedure('public.current_org_id()') is null then
    raise exception 'Run the earlier migrations first — this one builds on current_org_id().';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Consent on a contact
-- -----------------------------------------------------------------------------
alter table contacts
  add column if not exists marketing_consent  text not null default 'none',
  add column if not exists consent_source     text,
  add column if not exists consent_at         timestamptz,
  add column if not exists unsubscribed_at    timestamptz,
  /*
   * A per-contact secret in the unsubscribe link. A random token rather than a
   * signed id: it needs no key to verify, it can be rotated by writing a new
   * one, and a leaked link reveals nothing about the record it belongs to.
   */
  add column if not exists unsubscribe_token  uuid not null default gen_random_uuid();

alter table contacts drop constraint if exists contacts_marketing_consent_check;
alter table contacts add constraint contacts_marketing_consent_check
  check (marketing_consent in ('express', 'implied', 'none', 'unsubscribed'));

create unique index if not exists contacts_unsubscribe_token_key
  on contacts (unsubscribe_token);

comment on column contacts.marketing_consent is
  'express = they actively agreed. implied = an existing business relationship, which expires. none = do not send. unsubscribed = they asked to stop, and only they can undo it.';
comment on column contacts.consent_source is
  'Where the consent came from, in words somebody could defend later — a form, a trade show, a signed contract.';
comment on column contacts.consent_at is
  'When consent was given. Implied consent ages out from this date.';

-- -----------------------------------------------------------------------------
-- Suppression
--
-- Keyed on the address, not the contact. The same person may sit in the
-- database twice, and somebody who unsubscribes has unsubscribed — not
-- unsubscribed from one of their duplicate records.
-- -----------------------------------------------------------------------------
create table if not exists email_suppressions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  email           text not null,
  reason          text not null check (reason in ('unsubscribed', 'bounced', 'complained', 'manual')),
  note            text,
  contact_id      uuid references contacts (id) on delete set null,
  created_at      timestamptz not null default now()
);

-- Lower-cased so a suppression cannot be walked around by changing the case of
-- an address, which is not a different address.
create unique index if not exists email_suppressions_unique
  on email_suppressions (organization_id, lower(email));

create index if not exists email_suppressions_org_idx
  on email_suppressions (organization_id);

comment on table email_suppressions is
  'Addresses that must never receive marketing, whatever a list or a filter says. Checked at send time, not only when an audience is built.';

-- -----------------------------------------------------------------------------
-- Lists
--
-- Two kinds, distinguished by whether a saved filter is attached:
--
--   static   an explicit set of people, added by hand or from a selection
--   dynamic  a saved filter, re-read at send time so it stays current
--
-- `source_note` is not decoration. A list assembled from a trade show badge
-- scan and a list of existing customers have different standing, and the
-- difference has to be recorded when the list is made rather than remembered
-- later.
-- -----------------------------------------------------------------------------
create table if not exists email_lists (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name            text not null,
  description     text,
  source_note     text,
  saved_filter_id uuid references saved_filters (id) on delete set null,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists email_lists_org_idx on email_lists (organization_id);

create table if not exists email_list_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  list_id         uuid not null references email_lists (id) on delete cascade,
  contact_id      uuid not null references contacts (id) on delete cascade,
  added_by        uuid references users (id) on delete set null,
  added_at        timestamptz not null default now()
);

create unique index if not exists email_list_members_unique
  on email_list_members (list_id, contact_id);

create index if not exists email_list_members_contact_idx
  on email_list_members (contact_id);

comment on column email_lists.source_note is
  'Where this audience came from. Recorded when the list is made, because it is the answer to "on what basis did you mail these people".';
comment on column email_lists.saved_filter_id is
  'Set means the list is dynamic and re-reads itself at send time. Null means it is an explicit set of people.';

-- -----------------------------------------------------------------------------
-- May we email this person?
--
-- One place that answers it, so the audience screen, the send loop and any
-- report all agree. A view rather than a column: the answer depends on today's
-- date and on the suppression list, so it cannot be stored without going stale.
--
-- security_invoker so the caller's own row policies apply — without it a view
-- runs as its owner and would hand one tenant another's contacts.
-- -----------------------------------------------------------------------------
create or replace view contact_mailability
with (security_invoker = true) as
select
  c.id            as contact_id,
  c.organization_id,
  c.email,
  c.marketing_consent,
  c.consent_at,
  case
    when c.email is null or btrim(c.email) = ''      then 'no_email'
    when c.marketing_consent = 'unsubscribed'        then 'unsubscribed'
    when exists (
      select 1 from email_suppressions s
      where s.organization_id = c.organization_id
        and lower(s.email) = lower(c.email)
    )                                                then 'suppressed'
    when c.marketing_consent = 'none'                then 'no_consent'
    /*
     * Implied consent expires. Two years is the outer limit an existing
     * business relationship supports, and a contact whose consent has no date
     * at all cannot be shown to be inside it — so it counts as expired rather
     * than assumed good.
     */
    when c.marketing_consent = 'implied'
     and (c.consent_at is null or c.consent_at < now() - interval '2 years')
                                                     then 'consent_expired'
    else null
  end             as blocked_reason
from contacts c
where c.deleted_at is null
  and c.duplicate_of_id is null;

comment on view contact_mailability is
  'One row per live contact. blocked_reason is null when they may be emailed, and otherwise says why not.';

-- -----------------------------------------------------------------------------
-- Unsubscribing
--
-- Runs as definer and takes only the token, because the person clicking is not
-- logged in and belongs to no tenant. The token is the whole authorisation: it
-- identifies exactly one contact, and possessing it is the proof.
--
-- Both halves happen together — the contact is marked, and the address is
-- suppressed so a duplicate record of the same person is stopped too.
-- -----------------------------------------------------------------------------
create or replace function public.unsubscribe_by_token(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact contacts%rowtype;
begin
  select * into v_contact from contacts where unsubscribe_token = p_token;

  if not found then
    return false;
  end if;

  update contacts
  set marketing_consent = 'unsubscribed',
      unsubscribed_at   = coalesce(unsubscribed_at, now())
  where id = v_contact.id;

  if v_contact.email is not null and btrim(v_contact.email) <> '' then
    insert into email_suppressions (organization_id, email, reason, contact_id, note)
    values (v_contact.organization_id, lower(v_contact.email), 'unsubscribed', v_contact.id,
            'Unsubscribed from an email')
    on conflict (organization_id, lower(email)) do nothing;
  end if;

  return true;
end
$$;

/** Whether a token is real, so the page can say so without unsubscribing anybody. */
create or replace function public.unsubscribe_check(p_token uuid)
returns table (found boolean, email text, already boolean)
language sql
security definer
set search_path = public, pg_temp
as $$
  select true, c.email, c.marketing_consent = 'unsubscribed'
  from contacts c
  where c.unsubscribe_token = p_token;
$$;

revoke execute on function public.unsubscribe_by_token(uuid) from public;
revoke execute on function public.unsubscribe_check(uuid) from public;
-- anon on purpose: the person clicking the link has no account and must not
-- need one. The token is the only thing standing in for identity, which is why
-- it is random and unguessable rather than derived from the contact's id.
grant execute on function public.unsubscribe_by_token(uuid) to anon, authenticated, service_role;
grant execute on function public.unsubscribe_check(uuid) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Row-level security, matching every other table here
-- -----------------------------------------------------------------------------
alter table email_suppressions enable row level security;
alter table email_lists        enable row level security;
alter table email_list_members enable row level security;

alter table email_suppressions force row level security;
alter table email_lists        force row level security;
alter table email_list_members force row level security;

create policy email_suppressions_select on email_suppressions
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy email_suppressions_insert on email_suppressions
  for insert to authenticated
  with check (organization_id = public.current_org_id());

-- Removing a suppression is undoing somebody's stated wish, so it is an
-- administrator's decision and never an ordinary edit.
create policy email_suppressions_delete on email_suppressions
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());

create policy email_lists_select on email_lists
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy email_lists_insert on email_lists
  for insert to authenticated
  with check (organization_id = public.current_org_id());

create policy email_lists_update on email_lists
  for update to authenticated
  using (organization_id = public.current_org_id())
  with check (organization_id = public.current_org_id());

create policy email_lists_delete on email_lists
  for delete to authenticated
  using (
    organization_id = public.current_org_id()
    and (created_by = public.current_app_user_id() or public.is_org_admin())
  );

create policy email_list_members_select on email_list_members
  for select to authenticated
  using (organization_id = public.current_org_id());

create policy email_list_members_insert on email_list_members
  for insert to authenticated
  with check (organization_id = public.current_org_id());

create policy email_list_members_delete on email_list_members
  for delete to authenticated
  using (organization_id = public.current_org_id());

grant select, insert, update, delete on email_suppressions to authenticated;
grant select, insert, update, delete on email_lists        to authenticated;
grant select, insert, update, delete on email_list_members to authenticated;
grant select on contact_mailability to authenticated;

-- -----------------------------------------------------------------------------
-- Consent is a bulk field
--
-- Marking a few hundred existing contacts as implied consent, with a source and
-- a date, is the first real job this feature has. Doing it one record at a time
-- would mean it never gets done.
-- -----------------------------------------------------------------------------
create or replace function public.bulk_set_consent(
  p_ids uuid[],
  p_consent text,
  p_source text,
  p_at timestamptz default now()
)
returns integer
-- INVOKER, like bulk_update_records: only records the caller could already
-- edit are touched, and the row policies decide which those are.
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_org   uuid := public.current_org_id();
  v_count integer;
begin
  if v_org is null then
    raise exception 'No organization in context';
  end if;

  if p_consent not in ('express', 'implied', 'none') then
    -- Deliberately not 'unsubscribed'. Nobody unsubscribes on somebody else's
    -- behalf in bulk; that only ever comes from the person themselves.
    raise exception 'Consent must be express, implied or none';
  end if;

  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  if array_length(p_ids, 1) > 500 then
    raise exception 'Too many records in one change (limit 500)';
  end if;

  update contacts
  set marketing_consent = p_consent,
      consent_source    = nullif(btrim(coalesce(p_source, '')), ''),
      consent_at        = case when p_consent = 'none' then null else coalesce(p_at, now()) end
  where id = any(p_ids)
    and organization_id = v_org
    -- Someone who unsubscribed stays unsubscribed. A bulk edit is exactly the
    -- accident that would otherwise quietly re-subscribe them.
    and marketing_consent <> 'unsubscribed';

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function public.bulk_set_consent(uuid[], text, text, timestamptz) from public;
grant execute on function public.bulk_set_consent(uuid[], text, text, timestamptz)
  to authenticated, service_role;
