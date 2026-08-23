-- =============================================================================
-- A suspended organization is actually switched off.
--
--   organizations.status existed from the first migration and nothing read it,
--   so setting an account inactive changed a value and nothing else. These are
--   the checks that make it mean something:
--
--     * the session helper resolves to null, which is what makes every policy
--       in the schema refuse without any of them having to mention status;
--     * an active organization alongside it is completely unaffected — the
--       failure mode of getting this wrong is locking out the paying accounts,
--       not the suspended one;
--     * turning it back on restores everything, because nothing was deleted;
--     * the public forms stop as well. They belong to the organization rather
--       than to a session, so current_org_id() has nothing to say about them,
--       and without their own check they would carry on collecting leads for an
--       account whose staff can no longer read them.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

create table fixture (key text primary key, id uuid);
grant select, insert on fixture to authenticated, anon;

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

revoke execute on function test_assert(boolean, text) from public, anon;
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

do $$
declare
  v_live    uuid;
  v_shut    uuid;
  v_live_a  uuid := gen_random_uuid();
  v_shut_a  uuid := gen_random_uuid();
  v_live_u  uuid;
  v_shut_u  uuid;
begin
  insert into organizations (name, slug) values ('Still Trading', 'still-trading')
  returning id into v_live;
  insert into organizations (name, slug) values ('Wound Down', 'wound-down')
  returning id into v_shut;

  insert into auth.users (id, email) values
    (v_live_a, 'ada@still.test'), (v_shut_a, 'sam@wound.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_live, 'ada@still.test', 'Ada', 'admin', v_live_a, 'active')
  returning id into v_live_u;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_shut, 'sam@wound.test', 'Sam', 'admin', v_shut_a, 'active')
  returning id into v_shut_u;

  insert into contacts (organization_id, first_name, last_name, email, owner_id)
  values (v_live, 'Live', 'Contact', 'live@example.test', v_live_u),
         (v_shut, 'Shut', 'Contact', 'shut@example.test', v_shut_u);

  insert into marketing_forms (organization_id, name, slug, status, headline, fields)
  values (v_shut, 'Still up', 'wound-down-form', 'published', 'Get in touch',
          '[{"key":"email","label":"Email","type":"email","required":true,"maps_to":"email"}]'::jsonb);

  insert into fixture values
    ('live', v_live), ('shut', v_shut),
    ('live_auth', v_live_a), ('shut_auth', v_shut_a);
end;
$$;

-- =============================================================================
-- While both are active, both work. The baseline matters: without it, a test
-- that locks everybody out passes for the wrong reason.
-- =============================================================================
set local role authenticated;

do $$
begin
  raise notice 'Both active:';

  perform sign_in_as('live_auth');
  perform test_assert(public.current_org_id() = (select id from fixture where key='live'),
    'somebody in a live organization gets a session');
  perform test_assert((select count(*) from contacts) = 1,
    'and sees their own contact');

  perform sign_in_as('shut_auth');
  perform test_assert(public.current_org_id() = (select id from fixture where key='shut'),
    'and so does somebody in the organization about to be suspended');
  perform test_assert((select count(*) from contacts) = 1,
    'who can also see theirs, for now');
end;
$$;

reset role;

-- =============================================================================
-- Switch one off.
-- =============================================================================
do $$
begin
  update organizations set status = 'inactive'
  where id = (select id from fixture where key = 'shut');
end;
$$;

set local role authenticated;

do $$
begin
  raise notice 'One suspended:';

  perform sign_in_as('shut_auth');
  perform test_assert(public.current_org_id() is null,
    'a suspended organization resolves to no session at all');
  perform test_assert((select count(*) from public.current_user_org_ids()) = 0,
    'and to no membership, so a future organization switcher cannot reach it either');
  perform test_assert((select count(*) from contacts) = 0,
    'so no contact is readable — the policies refuse without mentioning status');
  perform test_assert((select count(*) from organizations) = 0,
    'not even the organization row itself');

  perform test_assert(public.access_denied_reason() = 'organization_inactive',
    'and /no-access can say why, which is the difference between "ask for an invitation" and "ask for it to be turned back on"');

  -- The check that matters most. Suspending one account must not touch another.
  perform sign_in_as('live_auth');
  perform test_assert(public.current_org_id() = (select id from fixture where key='live'),
    'the live organization is completely unaffected');
  perform test_assert((select count(*) from contacts) = 1,
    'and still sees its own contact');
  perform test_assert(public.access_denied_reason() = 'none',
    'with nothing to explain away');
end;
$$;

reset role;

-- =============================================================================
-- The front door closes too.
-- =============================================================================

/* The harness helper, for the one block that runs with no session at all. */
grant execute on function test_assert(boolean, text) to anon;

set local role anon;

do $$
declare
  v_result jsonb;
begin
  raise notice 'Its public form:';

  perform test_assert(public.marketing_form_public('wound-down-form') is null,
    'a suspended account''s published form stops being readable');

  v_result := public.submit_marketing_form('wound-down-form',
    '{"email":"buyer@example.test"}'::jsonb);
  perform test_assert(v_result ->> 'ok' = 'false',
    'and stops accepting submissions, not merely stops rendering');
  perform test_assert(v_result ->> 'error' not ilike '%suspend%'
                  and v_result ->> 'error' not ilike '%inactive%',
    'without telling a stranger anything about the state of the account');
end;
$$;

reset role;

-- =============================================================================
-- Nothing was deleted.
-- =============================================================================
do $$
begin
  update organizations set status = 'active'
  where id = (select id from fixture where key = 'shut');
end;
$$;

set local role authenticated;

do $$
begin
  raise notice 'Turned back on:';

  perform sign_in_as('shut_auth');
  perform test_assert(public.current_org_id() = (select id from fixture where key='shut'),
    'reactivating restores the session');
  perform test_assert((select count(*) from contacts) = 1,
    'and the records are exactly where they were — this was a switch, not a delete');
end;
$$;

reset role;

rollback;
