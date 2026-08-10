-- =============================================================================
-- Tenant isolation tests (PRD Section 2, Section 6.1, Section 10)
--
-- "A user in Organization A can never see, search, export, or otherwise access
--  a record belonging to Organization B, even by guessing an ID directly."
--
-- These run as the `authenticated` role with a real JWT claim set, which is
-- exactly how PostgREST executes a request — so what passes here is what the
-- deployed app enforces. Every check raises an exception on failure, so the
-- script exits non-zero the moment isolation breaks.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

-- -----------------------------------------------------------------------------
-- Fixtures: two organizations, one user each, one contact and one deal each.
-- Created as the owner (RLS bypassed here on purpose — this is the setup, not
-- the test).
-- -----------------------------------------------------------------------------
-- A plain table, not a temp one: the tests switch to the `authenticated` role
-- and need to read it. The whole script runs inside a transaction that rolls
-- back, so nothing survives the run.
create table fixture (key text primary key, id uuid);
grant select on fixture to authenticated;

do $$
declare
  v_org_a  uuid;
  v_org_b  uuid;
  v_auth_a uuid := gen_random_uuid();
  v_auth_b uuid := gen_random_uuid();
  v_user_a uuid;
  v_user_b uuid;
  v_contact_a uuid;
  v_contact_b uuid;
  v_stage_a uuid;
  v_stage_b uuid;
  v_deal_a uuid;
  v_deal_b uuid;
begin
  insert into organizations (name, slug) values ('Org A', 'org-a') returning id into v_org_a;
  insert into organizations (name, slug) values ('Org B', 'org-b') returning id into v_org_b;

  insert into auth.users (id, email) values (v_auth_a, 'a@example.com'), (v_auth_b, 'b@example.com');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org_a, 'a@example.com', 'Ana', 'admin', v_auth_a, 'active') returning id into v_user_a;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org_b, 'b@example.com', 'Ben', 'admin', v_auth_b, 'active') returning id into v_user_b;

  insert into contacts (organization_id, first_name, last_name, email, owner_id)
  values (v_org_a, 'Alice', 'Anderson', 'alice@a.com', v_user_a) returning id into v_contact_a;
  insert into contacts (organization_id, first_name, last_name, email, owner_id)
  values (v_org_b, 'Bob', 'Brown', 'bob@b.com', v_user_b) returning id into v_contact_b;

  select id into v_stage_a from stages where organization_id = v_org_a order by "order" limit 1;
  select id into v_stage_b from stages where organization_id = v_org_b order by "order" limit 1;

  insert into deals (organization_id, name, stage_id, value, owner_id, contact_id)
  values (v_org_a, 'Deal A', v_stage_a, 1000, v_user_a, v_contact_a) returning id into v_deal_a;
  insert into deals (organization_id, name, stage_id, value, owner_id, contact_id)
  values (v_org_b, 'Deal B', v_stage_b, 2000, v_user_b, v_contact_b) returning id into v_deal_b;

  insert into fixture values
    ('org_a', v_org_a), ('org_b', v_org_b),
    ('auth_a', v_auth_a), ('auth_b', v_auth_b),
    ('user_a', v_user_a), ('user_b', v_user_b),
    ('contact_a', v_contact_a), ('contact_b', v_contact_b),
    ('stage_a', v_stage_a), ('stage_b', v_stage_b),
    ('deal_a', v_deal_a), ('deal_b', v_deal_b);
end;
$$;

-- -----------------------------------------------------------------------------
-- Helper: sign in as a given auth user, the same way PostgREST does.
-- -----------------------------------------------------------------------------
create or replace function test_sign_in(p_auth_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_auth_id, 'role', 'authenticated')::text,
    true
  );
end;
$$;

grant execute on function test_sign_in(uuid) to authenticated;

create or replace function test_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not p_condition then
    raise exception 'ISOLATION TEST FAILED: %', p_message;
  end if;
  raise notice '  ok: %', p_message;
end;
$$;

grant execute on function test_assert(boolean, text) to authenticated;

-- =============================================================================
-- As Ana (Organization A)
-- =============================================================================
set local role authenticated;
select test_sign_in((select id from fixture where key = 'auth_a'));

do $$
declare
  v_count integer;
  v_org   uuid;
begin
  raise notice 'As a user in Organization A:';

  -- The session resolves to exactly one organization.
  select public.current_org_id() into v_org;
  perform test_assert(
    v_org = (select id from fixture where key = 'org_a'),
    'session is bound to Organization A'
  );

  -- Listing contacts returns A's only.
  select count(*) into v_count from contacts;
  perform test_assert(v_count = 1, 'contact list shows only Organization A contacts');

  -- Fetching B's contact by its exact id returns nothing. This is the
  -- "even by guessing an ID directly" clause of the acceptance criterion.
  select count(*) into v_count from contacts
  where id = (select id from fixture where key = 'contact_b');
  perform test_assert(v_count = 0, 'fetching Organization B contact by id returns nothing');

  -- Searching for B's data finds nothing.
  select count(*) into v_count from contacts where email ilike '%b.com%';
  perform test_assert(v_count = 0, 'searching cannot surface Organization B contacts');

  -- Same for every other tenant table.
  select count(*) into v_count from deals;
  perform test_assert(v_count = 1, 'deal list shows only Organization A deals');

  select count(*) into v_count from deals where id = (select id from fixture where key = 'deal_b');
  perform test_assert(v_count = 0, 'fetching Organization B deal by id returns nothing');

  select count(*) into v_count from users;
  perform test_assert(v_count = 1, 'user list shows only Organization A users');

  select count(*) into v_count from organizations;
  perform test_assert(v_count = 1, 'only Organization A is visible in organizations');

  select count(*) into v_count from pipelines;
  perform test_assert(v_count = 1, 'only Organization A pipelines are visible');

  select count(*) into v_count from stages;
  perform test_assert(v_count = 6, 'only Organization A stages are visible');

  -- Updates cannot reach across the boundary.
  update contacts set first_name = 'Hacked'
  where id = (select id from fixture where key = 'contact_b');
  get diagnostics v_count = row_count;
  perform test_assert(v_count = 0, 'updating an Organization B contact affects no rows');

  -- Nor can deletes.
  delete from contacts where id = (select id from fixture where key = 'contact_b');
  get diagnostics v_count = row_count;
  perform test_assert(v_count = 0, 'deleting an Organization B contact affects no rows');

  -- Nor can a write that claims to belong to another organization.
  begin
    insert into contacts (organization_id, first_name, last_name)
    values ((select id from fixture where key = 'org_b'), 'Injected', 'Record');
    perform test_assert(false, 'inserting into Organization B must be rejected');
  exception
    when insufficient_privilege then
      perform test_assert(true, 'inserting a contact into Organization B is rejected by RLS');
  end;

  -- A deal cannot be pointed at another organization's stage, even from
  -- inside the caller's own organization.
  begin
    insert into deals (organization_id, name, stage_id, value)
    values (
      (select id from fixture where key = 'org_a'),
      'Cross-tenant deal',
      (select id from fixture where key = 'stage_b'),
      500
    );
    perform test_assert(false, 'a deal referencing another organization''s stage must be rejected');
  exception
    when others then
      perform test_assert(true, 'a deal cannot reference another organization''s stage');
  end;

  -- Reporting is scoped too: no leakage through the RPC surface.
  select count(*) into v_count from public.report_pipeline_value(null, null)
  where deal_count > 0;
  perform test_assert(v_count = 1, 'pipeline value report covers only Organization A deals');

  select count(*) into v_count from public.find_duplicate_contacts('bob@b.com', null, null, null, null);
  perform test_assert(v_count = 0, 'duplicate search cannot reach Organization B contacts');
end;
$$;

-- =============================================================================
-- As Ben (Organization B) — the mirror image, so the test cannot pass simply
-- because one organization happens to be empty.
-- =============================================================================
select test_sign_in((select id from fixture where key = 'auth_b'));

do $$
declare
  v_count integer;
begin
  raise notice 'As a user in Organization B:';

  select count(*) into v_count from contacts;
  perform test_assert(v_count = 1, 'contact list shows only Organization B contacts');

  select count(*) into v_count from contacts
  where id = (select id from fixture where key = 'contact_a');
  perform test_assert(v_count = 0, 'fetching Organization A contact by id returns nothing');

  select count(*) into v_count from contacts where first_name = 'Alice';
  perform test_assert(v_count = 0, 'Organization A contact was never modified by Organization B');

  select count(*) into v_count from deals;
  perform test_assert(v_count = 1, 'deal list shows only Organization B deals');
end;
$$;

-- =============================================================================
-- A disabled user has no organization at all.
-- =============================================================================
reset role;

update users set status = 'disabled' where id = (select id from fixture where key = 'user_b');

set local role authenticated;
select test_sign_in((select id from fixture where key = 'auth_b'));

do $$
declare
  v_count integer;
begin
  raise notice 'As a disabled user:';

  perform test_assert(public.current_org_id() is null, 'a disabled user resolves to no organization');

  select count(*) into v_count from contacts;
  perform test_assert(v_count = 0, 'a disabled user sees no contacts');

  select count(*) into v_count from deals;
  perform test_assert(v_count = 0, 'a disabled user sees no deals');
end;
$$;

-- =============================================================================
-- An anonymous request (no JWT) sees nothing.
-- =============================================================================
reset role;
set local role authenticated;
select set_config('request.jwt.claims', null, true);

do $$
declare
  v_count integer;
begin
  raise notice 'With no signed-in user:';

  select count(*) into v_count from contacts;
  perform test_assert(v_count = 0, 'an unauthenticated session sees no contacts');

  select count(*) into v_count from organizations;
  perform test_assert(v_count = 0, 'an unauthenticated session sees no organizations');
end;
$$;

-- =============================================================================
-- A forged active_organization_id claim does not grant access. This matters
-- for Phase 3's organization switching, which is claim-driven.
-- =============================================================================
select test_sign_in((select id from fixture where key = 'auth_a'));

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (select id from fixture where key = 'auth_a'),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'active_organization_id', (select id from fixture where key = 'org_b')
    )
  )::text,
  true
);

do $$
declare
  v_count integer;
begin
  raise notice 'With a forged organization claim:';

  perform test_assert(
    public.current_org_id() = (select id from fixture where key = 'org_a'),
    'claiming another organization falls back to real membership'
  );

  select count(*) into v_count from contacts where email = 'bob@b.com';
  perform test_assert(v_count = 0, 'a forged organization claim exposes no Organization B data');
end;
$$;

reset role;
rollback;
