-- =============================================================================
-- Hidden contacts and companies.
--
--   A hidden record is out of sight for everybody without see_hidden — not
--   only out of the list, but out of the count, out of a direct lookup by id,
--   out of an update, and out of the campaign audience.
--
--   The last one matters most. Row-level security covers the app's own
--   queries; the campaign builders read contacts as SECURITY DEFINER and go
--   straight past it. A hidden contact that still receives the newsletter is
--   not hidden, and nothing about the policies would have told anybody.
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

/** Whether a contact is hidden, read past every policy. */
create or replace function is_hidden(p_key text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select hidden from contacts where id = (select id from fixture where key = p_key);
$$;

grant execute on function is_hidden(text) to authenticated;

do $$
declare
  v_org    uuid;
  v_aa     uuid := gen_random_uuid();
  v_ra     uuid := gen_random_uuid();
  v_ma     uuid := gen_random_uuid();
  v_admin  uuid;
  v_rep    uuid;
  v_mgr    uuid;
  v_quiet  uuid;
  v_open   uuid;
  v_co     uuid;
  v_list   uuid;
  v_camp   uuid;
begin
  insert into organizations (name, slug) values ('Quiet Co', 'quiet-co') returning id into v_org;

  insert into auth.users (id, email) values
    (v_aa, 'admin@quiet.test'), (v_ra, 'rep@quiet.test'), (v_ma, 'manager@quiet.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@quiet.test', 'Ada', 'admin', v_aa, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@quiet.test', 'Raj', 'regular', v_ra, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'manager@quiet.test', 'Mia', 'manager', v_ma, 'active') returning id into v_mgr;

  -- Owned by the rep, so that when it disappears for them it is not because of
  -- ownership. That distinction is the whole test.
  insert into contacts (organization_id, first_name, last_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Quiet', 'One', 'quiet@example.test', v_rep, 'express', now())
  returning id into v_quiet;

  insert into contacts (organization_id, first_name, last_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Open', 'Two', 'open@example.test', v_rep, 'express', now())
  returning id into v_open;

  insert into companies (organization_id, name) values (v_org, 'Quiet Holdings') returning id into v_co;

  insert into email_lists (organization_id, name) values (v_org, 'Everyone') returning id into v_list;
  insert into email_list_members (organization_id, list_id, contact_id)
  values (v_org, v_list, v_quiet), (v_org, v_list, v_open);

  insert into campaigns (organization_id, name, subject, body, list_id)
  values (v_org, 'Newsletter', 'Hello', 'Body', v_list)
  returning id into v_camp;

  insert into fixture values
    ('org', v_org), ('admin_auth', v_aa), ('rep_auth', v_ra), ('manager_auth', v_ma),
    ('admin', v_admin), ('rep', v_rep),
    ('quiet', v_quiet), ('open', v_open), ('company', v_co),
    ('list', v_list), ('campaign', v_camp);
end;
$$;

set local role authenticated;

-- =============================================================================
-- Who has the capability to begin with.
--
-- Seeded onto the sets that can already edit permissions, not onto every
-- administrator. Nothing is hidden yet, so this reveals nothing either way — it
-- is the starting position, not a behaviour change.
-- =============================================================================
do $$
begin
  perform sign_in_as('admin_auth');
  perform test_assert(public.can_see_hidden(), 'an administrator starts with it');

  perform sign_in_as('manager_auth');
  perform test_assert(not public.can_see_hidden(), 'a manager does not');

  perform sign_in_as('rep_auth');
  perform test_assert(not public.can_see_hidden(), 'nor a sales rep');
end;
$$;

-- =============================================================================
-- Only somebody with the capability can move the flag.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('rep_auth');

  begin
    update contacts set hidden = true where id = (select id from fixture where key = 'quiet');
    perform test_assert(false, 'a rep cannot hide their own contact');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%do not have permission%', 'and is told why');
  perform test_assert(not is_hidden('quiet'), 'and it is still visible');
end;
$$;

-- =============================================================================
-- Hidden means gone, including from the person who owns it.
--
-- The contact belongs to the rep. Ownership is not what takes it away.
-- =============================================================================
do $$
declare v_count integer;
begin
  perform sign_in_as('admin_auth');
  update contacts set hidden = true where id = (select id from fixture where key = 'quiet');
  perform test_assert(is_hidden('quiet'), 'an administrator can hide one');

  perform test_assert(
    (select hidden_by from contacts where id = (select id from fixture where key = 'quiet'))
      = (select id from fixture where key = 'admin'),
    'and it records who did it');
  perform test_assert(
    (select hidden_at is not null from contacts where id = (select id from fixture where key = 'quiet')),
    'and when');

  perform sign_in_as('rep_auth');

  select count(*) into v_count from contacts where id = (select id from fixture where key = 'quiet');
  perform test_assert(v_count = 0, 'its own owner cannot see it');

  select count(*) into v_count from contacts;
  perform test_assert(v_count = 1, 'and it is out of the list, not merely unopenable');

  perform sign_in_as('manager_auth');
  select count(*) into v_count from contacts where id = (select id from fixture where key = 'quiet');
  perform test_assert(v_count = 0, 'a manager who sees every record cannot see this one');

  perform sign_in_as('admin_auth');
  select count(*) into v_count from contacts where id = (select id from fixture where key = 'quiet');
  perform test_assert(v_count = 1, 'and somebody with the capability can');
end;
$$;

-- =============================================================================
-- Nor can they edit it, or delete it, by knowing its id.
-- =============================================================================
do $$
declare v_count integer;
begin
  perform sign_in_as('manager_auth');

  update contacts set first_name = 'Renamed'
  where id = (select id from fixture where key = 'quiet');
  get diagnostics v_count = row_count;
  perform test_assert(v_count = 0, 'an update by id reaches nothing');

  perform test_assert(
    (select first_name from contacts where id = (select id from fixture where key = 'quiet')) is null,
    'and the row is not readable to confirm it either way');
end;
$$;

-- =============================================================================
-- Unhiding puts it back, and clears the stamp.
-- =============================================================================
do $$
begin
  perform sign_in_as('admin_auth');

  update contacts set hidden = false where id = (select id from fixture where key = 'quiet');
  perform test_assert(not is_hidden('quiet'), 'it can be put back');
  perform test_assert(
    (select hidden_at is null and hidden_by is null from contacts
     where id = (select id from fixture where key = 'quiet')),
    'and the stamp goes with it rather than lingering as a false record');

  perform sign_in_as('rep_auth');
  perform test_assert(
    exists (select 1 from contacts where id = (select id from fixture where key = 'quiet')),
    'and its owner has it back');
end;
$$;

-- =============================================================================
-- Companies too.
-- =============================================================================
do $$
declare v_count integer;
begin
  perform sign_in_as('admin_auth');
  update companies set hidden = true where id = (select id from fixture where key = 'company');

  perform sign_in_as('manager_auth');
  select count(*) into v_count from companies where id = (select id from fixture where key = 'company');
  perform test_assert(v_count = 0, 'a hidden company is gone for a manager');

  perform sign_in_as('admin_auth');
  select count(*) into v_count from companies where id = (select id from fixture where key = 'company');
  perform test_assert(v_count = 1, 'and there for somebody with the capability');

  update companies set hidden = false where id = (select id from fixture where key = 'company');
end;
$$;

-- =============================================================================
-- A hidden contact is not audience.
--
-- This is the one row-level security would never have covered:
-- build_campaign_audience is SECURITY DEFINER and reads contacts past every
-- policy. A hidden contact that still receives the newsletter is not hidden.
-- =============================================================================
do $$
declare v_added integer; v_count integer;
begin
  perform sign_in_as('admin_auth');
  update contacts set hidden = true where id = (select id from fixture where key = 'quiet');

  v_added := public.build_campaign_audience((select id from fixture where key = 'campaign'));

  perform test_assert(v_added = 1, 'the audience takes the visible contact only');

  select count(*) into v_count from campaign_recipients
  where campaign_id = (select id from fixture where key = 'campaign')
    and contact_id = (select id from fixture where key = 'quiet');

  perform test_assert(v_count = 0, 'and the hidden one is not queued to be emailed');

  select count(*) into v_count from campaign_recipients
  where campaign_id = (select id from fixture where key = 'campaign')
    and contact_id = (select id from fixture where key = 'open');

  perform test_assert(v_count = 1, 'while the visible one is');
end;
$$;

-- =============================================================================
-- Nor does it generate a birthday reminder naming itself.
-- =============================================================================
do $$
declare v_made integer; v_count integer;
begin
  reset role;
  -- Exactly p_days_ahead away: the function matches the day, not a window.
  update contacts set birthday = current_date + 3
  where id in (
    (select id from fixture where key = 'quiet'),
    (select id from fixture where key = 'open'));
  set local role authenticated;

  perform sign_in_as('admin_auth');
  reset role;
  v_made := public.create_birthday_reminders(3);
  set local role authenticated;
  perform sign_in_as('admin_auth');

  select count(*) into v_count from activities
  where related_to_type = 'contact'
    and related_to_id = (select id from fixture where key = 'quiet');

  perform test_assert(v_count = 0, 'a hidden contact raises no reminder');

  select count(*) into v_count from activities
  where related_to_type = 'contact'
    and related_to_id = (select id from fixture where key = 'open');

  perform test_assert(v_count = 1, 'while a visible one does');
end;
$$;

-- =============================================================================
-- Hiding in bulk, which is what was asked for.
-- =============================================================================
do $$
declare v_changed integer; v_message text;
begin
  perform sign_in_as('admin_auth');

  v_changed := public.bulk_update_records(
    'contact',
    array[(select id from fixture where key = 'open')]::uuid[],
    'hidden', 'set', array['true']);

  perform test_assert(v_changed = 1, 'a set of contacts can be hidden in one change');
  perform test_assert(is_hidden('open'), 'and it took');

  v_changed := public.bulk_update_records(
    'contact',
    array[(select id from fixture where key = 'open')]::uuid[],
    'hidden', 'clear', array[]::text[]);

  perform test_assert(not is_hidden('open'), 'and cleared again');
end;
$$;

do $$
declare v_message text;
begin
  perform sign_in_as('manager_auth');

  begin
    perform public.bulk_update_records(
      'contact',
      array[(select id from fixture where key = 'open')]::uuid[],
      'hidden', 'set', array['true']);
    perform test_assert(false, 'bulk is not a way around the capability');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%do not have permission%', 'and the trigger is what says so');
  perform test_assert(not is_hidden('open'), 'and nothing moved');
end;
$$;

-- =============================================================================
-- What hiding a contact deliberately does not do.
--
-- Its deals stay visible, with the contact behind them unreadable. Written as a
-- test rather than left to a comment because it is the limit somebody will hit,
-- and a test is the only kind of documentation that fails when it stops being
-- true.
-- =============================================================================
do $$
declare v_deal uuid; v_count integer; v_stage uuid;
begin
  reset role;
  select s.id into v_stage from stages s join pipelines p on p.id = s.pipeline_id
  where p.organization_id = (select id from fixture where key = 'org') order by s."order" limit 1;

  insert into deals (organization_id, name, stage_id, owner_id, contact_id, value, currency)
  values ((select id from fixture where key = 'org'), 'Quiet deal', v_stage,
          (select id from fixture where key = 'rep'),
          (select id from fixture where key = 'quiet'), 100, 'USD')
  returning id into v_deal;
  set local role authenticated;

  perform sign_in_as('rep_auth');

  select count(*) into v_count from deals where id = v_deal;
  perform test_assert(v_count = 1, 'a deal on a hidden contact stays visible');

  select count(*) into v_count from contacts
  where id = (select contact_id from deals where id = v_deal);
  perform test_assert(v_count = 0, 'while the contact behind it does not resolve');
end;
$$;

rollback;
