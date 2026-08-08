-- =============================================================================
-- Role and ownership tests.
--
-- Every assertion runs as the `authenticated` role with real JWT claims — the
-- same path PostgREST uses — because the whole point is that these rules hold
-- against the REST API, not just against a UI that hides buttons.
--
--   Admin           configuration, users, every record including deleted ones
--   Manager         every live record; delete, import, export, reassign
--   Sales director   own + unassigned; delete, import, export, reassign
--   Regular          "Sales rep" — own only; create, edit, delete
--   Readonly         reads, writes nothing
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

/** Signs the session in as one of the fixture users. */
create or replace function sign_in_as(p_key text)
returns void
language plpgsql
as $$
declare
  v_auth uuid := (select id from fixture where key = p_key);
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_auth, 'role', 'authenticated')::text,
    true
  );
end;
$$;

grant execute on function sign_in_as(text) to authenticated;

-- -----------------------------------------------------------------------------
-- One organization, one of each role, and a record apiece.
-- -----------------------------------------------------------------------------
do $$
declare
  v_org      uuid;
  v_admin_a  uuid := gen_random_uuid();
  v_mgr_a    uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_rep2_a   uuid := gen_random_uuid();
  v_ro_a     uuid := gen_random_uuid();
  v_admin    uuid;
  v_mgr      uuid;
  v_rep      uuid;
  v_rep2     uuid;
  v_ro       uuid;
  v_company  uuid;
begin
  insert into organizations (name, slug) values ('Roles Co', 'roles-co') returning id into v_org;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@roles.test'), (v_mgr_a, 'mgr@roles.test'),
    (v_rep_a, 'rep@roles.test'), (v_rep2_a, 'rep2@roles.test'),
    (v_ro_a, 'ro@roles.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status) values
    (v_org, 'admin@roles.test', 'Ada',  'admin',    v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status) values
    (v_org, 'mgr@roles.test',   'Mina', 'manager',  v_mgr_a,   'active') returning id into v_mgr;
  insert into users (organization_id, email, name, role, auth_provider_id, status) values
    (v_org, 'rep@roles.test',   'Raj',  'regular',  v_rep_a,   'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status) values
    (v_org, 'rep2@roles.test',  'Rosa', 'regular',  v_rep2_a,  'active') returning id into v_rep2;
  insert into users (organization_id, email, name, role, auth_provider_id, status) values
    (v_org, 'ro@roles.test',    'Ollie','readonly', v_ro_a,    'active') returning id into v_ro;

  insert into companies (organization_id, name) values (v_org, 'Shared Co') returning id into v_company;

  insert into fixture values
    ('org', v_org),
    ('admin_auth', v_admin_a), ('mgr_auth', v_mgr_a), ('rep_auth', v_rep_a),
    ('rep2_auth', v_rep2_a), ('ro_auth', v_ro_a),
    ('admin', v_admin), ('mgr', v_mgr), ('rep', v_rep), ('rep2', v_rep2), ('ro', v_ro),
    ('company', v_company);

  -- One contact per rep, plus one nobody owns.
  declare
    v_mine   uuid;
    v_theirs uuid;
    v_orphan uuid;
  begin
    insert into contacts (organization_id, first_name, owner_id, company_id)
    values (v_org, 'Mine', v_rep, v_company) returning id into v_mine;
    insert into contacts (organization_id, first_name, owner_id, company_id)
    values (v_org, 'Theirs', v_rep2, v_company) returning id into v_theirs;
    insert into contacts (organization_id, first_name, owner_id)
    values (v_org, 'Orphan', null) returning id into v_orphan;

    insert into fixture values ('mine', v_mine), ('theirs', v_theirs), ('orphan', v_orphan);
  end;
end;
$$;

set local role authenticated;

-- =============================================================================
-- A regular user sees their own records, and unassigned ones, and no others.
-- =============================================================================
do $$
begin
  raise notice 'Regular user visibility:';
  perform sign_in_as('rep_auth');

  perform test_assert(
    (select count(*) from contacts where id = (select id from fixture where key = 'mine')) = 1,
    'a rep sees a contact they own'
  );

  perform test_assert(
    (select count(*) from contacts where id = (select id from fixture where key = 'theirs')) = 0,
    'a rep cannot see another rep''s contact'
  );

  -- A Sales Rep works their own book and nothing else: the unassigned pool
  -- belongs to the roles that can act on it.
  perform test_assert(
    (select count(*) from contacts where id = (select id from fixture where key = 'orphan')) = 0,
    'a sales rep does not see the unassigned pool'
  );

  perform test_assert(
    (select count(*) from contacts) = 1,
    'a listing returns only the rep''s own records'
  );

  -- Searching is the same query with a filter; it must not be a way around.
  perform test_assert(
    (select count(*) from contacts where first_name = 'Theirs') = 0,
    'searching by name does not surface a hidden contact'
  );

  perform test_assert(
    (select count(*) from companies) = 1,
    'companies stay shared, so a rep can still see where their contact works'
  );
end;
$$;

-- =============================================================================
-- A regular user may edit what they own, and nothing else.
-- =============================================================================
do $$
declare
  v_theirs uuid := (select id from fixture where key = 'theirs');
  v_mine   uuid := (select id from fixture where key = 'mine');
begin
  raise notice 'Regular user writes:';
  perform sign_in_as('rep_auth');

  update contacts set job_title = 'Buyer' where id = v_mine;
  perform test_assert(
    (select job_title from contacts where id = v_mine) = 'Buyer',
    'a rep can edit a contact they own'
  );

  -- An update that matches no visible row silently affects nothing, which is
  -- how RLS refuses a write. The absence of an error is the point.
  update contacts set job_title = 'Hijacked' where id = v_theirs;
  perform test_assert(
    (select count(*) from contacts where id = v_theirs and job_title = 'Hijacked') = 0,
    'a rep editing another rep''s contact changes nothing'
  );

  -- Deletion is soft now and goes through a function; a direct DELETE is
  -- reserved for an administrator emptying the bin.
  delete from contacts where id = v_mine;
  perform test_assert(
    (select count(*) from contacts where id = v_mine) = 1,
    'a rep cannot destroy a record with a direct DELETE'
  );
end;
$$;

-- =============================================================================
-- Handing an account over.
--
-- A plain UPDATE cannot do this: under FORCE ROW LEVEL SECURITY the new row
-- must still satisfy the SELECT policy, and a record owned by a colleague is
-- invisible by definition. reassign_contact() exists for exactly this — and it
-- is a Sales Director's tool, not a rep's.
-- =============================================================================
do $$
declare
  v_mine   uuid := (select id from fixture where key = 'mine');
  v_rep2   uuid := (select id from fixture where key = 'rep2');
  v_failed boolean := false;
begin
  raise notice 'Handover:';
  perform sign_in_as('rep_auth');

  begin
    update contacts set owner_id = v_rep2 where id = v_mine;
  exception when others then
    v_failed := true;
  end;
  perform test_assert(
    v_failed,
    'a direct UPDATE cannot move a record out of the writer''s own sight'
  );

  v_failed := false;
  begin
    perform reassign_contact(v_mine, v_rep2);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a sales rep cannot reassign a record');

  perform sign_in_as('mgr_auth');
  perform reassign_contact(v_mine, v_rep2);
  perform test_assert(
    (select owner_id from contacts where id = v_mine) = v_rep2,
    'a manager can hand the account over'
  );
end;
$$;

do $$
begin
  perform sign_in_as('mgr_auth');
  perform reassign_contact(
    (select id from fixture where key = 'mine'),
    (select id from fixture where key = 'rep')
  );
end;
$$;

-- The function must not become a back door to records the policies hide.
do $$
declare
  v_theirs uuid := (select id from fixture where key = 'theirs');
  v_rep    uuid := (select id from fixture where key = 'rep');
  v_failed boolean := false;
begin
  perform sign_in_as('rep_auth');

  begin
    perform reassign_contact(v_theirs, v_rep);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(
    v_failed,
    'reassign_contact refuses a record the caller cannot see'
  );

  perform sign_in_as('ro_auth');
  v_failed := false;
  begin
    perform reassign_contact((select id from fixture where key = 'orphan'), v_rep);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a read-only user cannot reassign anything');
end;
$$;

-- A rep cannot take a colleague's record by assigning it to themselves.
do $$
declare
  v_theirs uuid := (select id from fixture where key = 'theirs');
begin
  perform sign_in_as('rep_auth');

  update contacts set owner_id = (select id from fixture where key = 'rep') where id = v_theirs;

  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select owner_id from contacts where id = v_theirs) = (select id from fixture where key = 'rep2'),
    'a rep cannot claim a colleague''s contact by reassigning it to themselves'
  );
end;
$$;

-- =============================================================================
-- Read-only touches nothing.
--
-- Acts on the unassigned contact, which a read-only user can genuinely see.
-- Testing against a record they cannot see would pass whether or not the
-- write was refused, which proves nothing — every check below is confirmed
-- from a manager's view afterwards.
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_orphan uuid := (select id from fixture where key = 'orphan');
  v_failed boolean := false;
begin
  raise notice 'Read-only user:';
  perform sign_in_as('ro_auth');

  perform test_assert(
    (select count(*) from contacts where id = v_orphan) = 1,
    'a read-only user can read a contact they are allowed to see'
  );

  begin
    insert into contacts (organization_id, first_name) values (v_org, 'Nope');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a read-only user cannot create a contact');

  update contacts set job_title = 'Changed' where id = v_orphan;
  delete from contacts where id = v_orphan;

  v_failed := false;
  begin
    insert into companies (organization_id, name) values (v_org, 'Nope Co');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a read-only user cannot create a company');
end;
$$;

-- Confirmed from a vantage point that can see everything.
do $$
declare
  v_orphan uuid := (select id from fixture where key = 'orphan');
begin
  perform sign_in_as('mgr_auth');

  perform test_assert(
    (select count(*) from contacts where id = v_orphan) = 1,
    'the contact a read-only user tried to delete is still there'
  );

  perform test_assert(
    (select job_title from contacts where id = v_orphan) is distinct from 'Changed',
    'the edit a read-only user attempted did not land'
  );

  perform test_assert(
    (select count(*) from contacts where first_name = 'Nope') = 0,
    'the contact a read-only user tried to create was never written'
  );
end;
$$;

-- =============================================================================
-- Managers see and remove everything; admins too.
-- =============================================================================
do $$
declare
  v_theirs uuid := (select id from fixture where key = 'theirs');
begin
  raise notice 'Manager and admin:';
  perform sign_in_as('mgr_auth');

  perform test_assert(
    (select count(*) from contacts) = 3,
    'a manager sees every contact in the organization'
  );

  update contacts set job_title = 'Reviewed' where id = v_theirs;
  perform test_assert(
    (select job_title from contacts where id = v_theirs) = 'Reviewed',
    'a manager can edit a record they do not own'
  );

  perform sign_in_as('admin_auth');
  perform test_assert(
    (select count(*) from contacts) = 3,
    'an admin sees every contact too'
  );
end;
$$;

do $$
declare
  v_org  uuid := (select id from fixture where key = 'org');
  v_temp uuid;
begin
  perform sign_in_as('mgr_auth');

  insert into contacts (organization_id, first_name, owner_id) values (v_org, 'Doomed', null)
  returning id into v_temp;

  perform soft_delete_contact(v_temp);
  perform test_assert(
    (select count(*) from contacts where id = v_temp) = 0,
    'a manager can delete a contact, and it leaves their view'
  );
end;
$$;

-- =============================================================================
-- Activities inherit the visibility of the record they hang off.
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_mine   uuid := (select id from fixture where key = 'mine');
  v_theirs uuid := (select id from fixture where key = 'theirs');
  v_a1     uuid;
  v_a2     uuid;
begin
  raise notice 'Activities:';
  perform sign_in_as('mgr_auth');

  insert into activities (organization_id, type, related_to_type, related_to_id, owner_id, subject)
  values (v_org, 'note', 'contact', v_mine, (select id from fixture where key = 'rep'), 'On my contact')
  returning id into v_a1;

  insert into activities (organization_id, type, related_to_type, related_to_id, owner_id, subject)
  values (v_org, 'note', 'contact', v_theirs, (select id from fixture where key = 'rep2'), 'On their contact')
  returning id into v_a2;

  perform sign_in_as('rep_auth');

  perform test_assert(
    (select count(*) from activities where id = v_a1) = 1,
    'a rep sees activity on a contact they own'
  );

  perform test_assert(
    (select count(*) from activities where id = v_a2) = 0,
    'a rep cannot see activity on a contact they cannot see'
  );
end;
$$;

-- =============================================================================
-- Import and configuration stay out of a rep's hands.
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_failed boolean := false;
begin
  raise notice 'Import and configuration:';
  perform sign_in_as('rep_auth');

  begin
    insert into import_jobs (organization_id, entity_type, file_name, status)
    values (v_org, 'contact', 'sneaky.csv', 'pending');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a rep cannot start a bulk import');

  perform test_assert(
    (select count(*) from import_jobs) = 0,
    'a rep cannot read import jobs'
  );

  -- The gap this migration closes: the settings page required an admin, but
  -- the REST API did not.
  v_failed := false;
  begin
    insert into field_options (organization_id, entity_type, field_key, value, color)
    values (v_org, 'contact', 'priority', 'Sneaky', 'red');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a rep cannot add a field option');

  v_failed := false;
  begin
    insert into custom_field_definitions (organization_id, entity_type, key, label)
    values (v_org, 'contact', 'sneaky', 'Sneaky');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a rep cannot define a custom field');

  v_failed := false;
  begin
    insert into pipelines (organization_id, name) values (v_org, 'Sneaky pipeline');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a rep cannot create a pipeline');
end;
$$;

-- A manager may import, but still may not reconfigure the organization.
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_failed boolean := false;
begin
  perform sign_in_as('mgr_auth');

  insert into import_jobs (organization_id, entity_type, file_name, status)
  values (v_org, 'contact', 'legit.csv', 'pending');

  perform test_assert(
    (select count(*) from import_jobs) = 1,
    'a manager can start an import'
  );

  begin
    insert into pipelines (organization_id, name) values (v_org, 'Manager pipeline');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a manager still cannot reconfigure pipelines');
end;
$$;

-- =============================================================================
-- Tags: shared vocabulary anyone may add to, only a manager may remove.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
  v_tag uuid;
begin
  raise notice 'Tags:';
  perform sign_in_as('rep_auth');

  insert into tags (organization_id, name, color) values (v_org, 'Hot', '#ef4444')
  returning id into v_tag;
  perform test_assert(v_tag is not null, 'a rep can create a tag');

  delete from tags where id = v_tag;
  perform test_assert(
    (select count(*) from tags where id = v_tag) = 1,
    'a rep cannot delete a tag, which would strip it from every record'
  );

  perform sign_in_as('mgr_auth');
  delete from tags where id = v_tag;
  perform test_assert(
    (select count(*) from tags where id = v_tag) = 0,
    'a manager can delete a tag'
  );
end;
$$;

-- =============================================================================
-- A disabled user keeps no privileges from their former role.
-- =============================================================================
do $$
begin
  raise notice 'Disabled user:';

  set local role postgres;
  update users set status = 'disabled' where email = 'mgr@roles.test';

  set local role authenticated;
  perform sign_in_as('mgr_auth');

  perform test_assert(
    (select count(*) from contacts) = 0,
    'a disabled manager sees nothing at all'
  );

  perform test_assert(
    public.current_user_role() is null,
    'a disabled user resolves to no role'
  );
end;
$$;

rollback;
