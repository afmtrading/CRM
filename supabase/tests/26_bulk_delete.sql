-- =============================================================================
-- Deleting a selection.
--
--   A bulk delete is the most dangerous button in the application, so the
--   tests here are about what it refuses rather than what it does:
--
--     * a rep cannot delete a colleague's contact by including its id — the
--       row is skipped and the count comes back short, which is how the
--       interface learns to say "3 of 5";
--     * a hidden record is not deletable by somebody who cannot see it, so a
--       hidden contact cannot be discovered by watching it vanish;
--     * one organization cannot reach another's records by naming their ids;
--     * a second click deletes nothing, rather than restamping deleted_at and
--       losing when the deletion actually happened;
--     * the whole thing is one statement, so a selection is stamped together
--       or not at all;
--     * a role without delete_records is refused outright.
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

/** Reads past RLS, so a test can see a row the caller is not allowed to. */
create or replace function contact_deleted_at(p_contact uuid)
returns timestamptz
language sql
security definer
set search_path = public, pg_temp
as $$
  select deleted_at from contacts where id = p_contact;
$$;

create or replace function company_deleted_at(p_company uuid)
returns timestamptz
language sql
security definer
set search_path = public, pg_temp
as $$
  select deleted_at from companies where id = p_company;
$$;

create or replace function notice_count(p_org uuid, p_kind text)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from notifications
  where organization_id = p_org and kind = p_kind;
$$;

grant execute on function contact_deleted_at(uuid) to authenticated;
grant execute on function company_deleted_at(uuid) to authenticated;
grant execute on function notice_count(uuid, text) to authenticated;

do $$
declare
  v_org      uuid;
  v_other    uuid;
  v_admin_a  uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_rep2_a   uuid := gen_random_uuid();
  v_ro_a     uuid := gen_random_uuid();
  v_badmin_a uuid := gen_random_uuid();
  v_admin    uuid;
  v_rep      uuid;
  v_rep2     uuid;
  v_ro       uuid;
  v_badmin   uuid;
  v_c1       uuid;
  v_c2       uuid;
  v_theirs_rep uuid;
  v_hidden   uuid;
  v_co1      uuid;
  v_co2      uuid;
  v_co_hidden uuid;
  v_other_c  uuid;
begin
  insert into organizations (name, slug) values ('Bin Co', 'bin-co') returning id into v_org;
  insert into organizations (name, slug) values ('Other Bin Co', 'other-bin-co') returning id into v_other;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@bin.test'),
    (v_rep_a, 'rep@bin.test'),
    (v_rep2_a, 'rep2@bin.test'),
    (v_ro_a, 'ro@bin.test'),
    (v_badmin_a, 'admin@otherbin.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@bin.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@bin.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep2@bin.test', 'Rio', 'regular', v_rep2_a, 'active') returning id into v_rep2;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'ro@bin.test', 'Ola', 'readonly', v_ro_a, 'active') returning id into v_ro;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'admin@otherbin.test', 'Bo', 'admin', v_badmin_a, 'active') returning id into v_badmin;

  insert into contacts (organization_id, first_name, last_name, owner_id)
  values (v_org, 'One', 'Rep', v_rep) returning id into v_c1;
  insert into contacts (organization_id, first_name, last_name, owner_id)
  values (v_org, 'Two', 'Rep', v_rep) returning id into v_c2;
  -- Rio's, so Raj can name it but must not be able to delete it.
  insert into contacts (organization_id, first_name, last_name, owner_id)
  values (v_org, 'Three', 'Rep2', v_rep2) returning id into v_theirs_rep;
  -- Raj's own. Hidden below rather than here: the guard trigger refuses a
  -- hidden insert from anybody without see_hidden, and a fixture block has no
  -- session to have the capability in.
  insert into contacts (organization_id, first_name, last_name, owner_id)
  values (v_org, 'Four', 'Hidden', v_rep) returning id into v_hidden;

  insert into companies (organization_id, name) values (v_org, 'Bin Client') returning id into v_co1;
  insert into companies (organization_id, name) values (v_org, 'Bin Client Two') returning id into v_co2;
  insert into companies (organization_id, name)
  values (v_org, 'Quiet Client') returning id into v_co_hidden;

  insert into contacts (organization_id, first_name, last_name, owner_id)
  values (v_other, 'Their', 'Contact', v_badmin) returning id into v_other_c;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_admin_a), ('rep_auth', v_rep_a), ('rep2_auth', v_rep2_a),
    ('ro_auth', v_ro_a), ('badmin_auth', v_badmin_a),
    ('admin', v_admin), ('rep', v_rep),
    ('c1', v_c1), ('c2', v_c2), ('theirs_rep', v_theirs_rep), ('hidden', v_hidden),
    ('co1', v_co1), ('co2', v_co2), ('co_hidden', v_co_hidden),
    ('other_c', v_other_c);
end;
$$;

set local role authenticated;

-- Hiding takes see_hidden, so it happens as the administrator.
do $$
begin
  perform sign_in_as('admin_auth');
  update contacts set hidden = true where id = (select id from fixture where key = 'hidden');
  update companies set hidden = true where id = (select id from fixture where key = 'co_hidden');
end;
$$;

-- =============================================================================
-- The ordinary case, and the notification that describes it.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_deleted integer;
begin
  raise notice 'Deleting a selection:';
  perform sign_in_as('admin_auth');

  v_deleted := bulk_delete_records('company', array[
    (select id from fixture where key = 'co1'),
    (select id from fixture where key = 'co2')
  ]);

  perform test_assert(v_deleted = 2, 'the count returned is the number of records stamped');
  perform test_assert(
    company_deleted_at((select id from fixture where key = 'co1')) is not null
      and company_deleted_at((select id from fixture where key = 'co2')) is not null,
    'both records carry a deletion timestamp'
  );

  -- The point of the bulk function: one piece of news, not one per record.
  perform test_assert(
    notice_count(v_org, 'company_deleted') = 1,
    'two deletions produced one notification, not two'
  );
end;
$$;

-- =============================================================================
-- A second click changes nothing.
--
-- Restamping would move deleted_at forward and lose when the record actually
-- went, which is the one fact the recycle bin exists to keep.
-- =============================================================================
do $$
declare
  v_co1  uuid := (select id from fixture where key = 'co1');
  v_when timestamptz;
begin
  raise notice 'Deleting what is already deleted:';
  perform sign_in_as('admin_auth');

  v_when := company_deleted_at(v_co1);

  perform test_assert(
    bulk_delete_records('company', array[v_co1]) = 0,
    'an already-deleted record counts as nothing deleted'
  );
  perform test_assert(
    company_deleted_at(v_co1) = v_when,
    'and its original deletion time is untouched'
  );
end;
$$;

-- =============================================================================
-- Ownership. A rep may delete their own and no one else's.
-- =============================================================================
do $$
declare
  v_theirs uuid := (select id from fixture where key = 'theirs_rep');
begin
  raise notice 'Deleting past what you own:';
  perform sign_in_as('rep_auth');

  perform test_assert(
    bulk_delete_records('contact', array[
      (select id from fixture where key = 'c1'),
      v_theirs
    ]) = 1,
    'a selection of two containing one colleague''s record deletes one'
  );
  perform test_assert(
    contact_deleted_at(v_theirs) is null,
    'and the colleague''s record is untouched'
  );
  perform test_assert(
    contact_deleted_at((select id from fixture where key = 'c1')) is not null,
    'while the rep''s own is gone'
  );
end;
$$;

-- =============================================================================
-- Hidden records. Owning one is not enough; you have to be able to see it.
-- =============================================================================
do $$
declare
  v_hidden uuid := (select id from fixture where key = 'hidden');
begin
  raise notice 'Deleting what you cannot see:';
  perform sign_in_as('rep_auth');

  perform test_assert(
    bulk_delete_records('contact', array[v_hidden]) = 0,
    'a hidden contact the rep owns is still not deletable by them'
  );
  perform test_assert(
    contact_deleted_at(v_hidden) is null,
    'and it is still there'
  );

  -- Same rule on the single-record path, which used to test ownership only.
  begin
    perform soft_delete_contact(v_hidden);
    perform test_assert(false, 'soft_delete_contact should refuse a hidden contact');
  exception when others then
    perform test_assert(
      sqlerrm like '%not found%',
      'and it refuses with "not found" rather than admitting the record exists'
    );
  end;

  perform sign_in_as('admin_auth');
  perform test_assert(
    bulk_delete_records('contact', array[v_hidden]) = 1,
    'somebody with see_hidden deletes it normally'
  );
end;
$$;

-- =============================================================================
-- Hidden companies, the same way.
-- =============================================================================
do $$
declare
  v_quiet uuid := (select id from fixture where key = 'co_hidden');
begin
  raise notice 'Hidden companies:';
  perform sign_in_as('rep_auth');

  perform test_assert(
    bulk_delete_records('company', array[v_quiet]) = 0,
    'a hidden company is not deletable by somebody without see_hidden'
  );

  begin
    perform soft_delete_company(v_quiet);
    perform test_assert(false, 'soft_delete_company should refuse a hidden company');
  exception when others then
    perform test_assert(
      sqlerrm like '%not found%',
      'and refuses without confirming it exists'
    );
  end;

  perform test_assert(company_deleted_at(v_quiet) is null, 'it survives both attempts');
end;
$$;

-- =============================================================================
-- Tenancy. Naming another organization's ids achieves nothing.
-- =============================================================================
do $$
declare
  v_theirs uuid := (select id from fixture where key = 'other_c');
begin
  raise notice 'Reaching into another organization:';
  perform sign_in_as('admin_auth');

  perform test_assert(
    bulk_delete_records('contact', array[v_theirs]) = 0,
    'an administrator cannot delete another organization''s contact'
  );
  perform test_assert(
    contact_deleted_at(v_theirs) is null,
    'the record is untouched'
  );
end;
$$;

-- =============================================================================
-- Permission, and the ceiling.
-- =============================================================================
do $$
declare
  v_c2 uuid := (select id from fixture where key = 'c2');
begin
  raise notice 'Refusals:';

  perform sign_in_as('ro_auth');
  begin
    perform bulk_delete_records('contact', array[v_c2]);
    perform test_assert(false, 'a read-only user should not be able to delete');
  exception when others then
    perform test_assert(
      sqlerrm like '%does not allow%',
      'a read-only user is refused by name'
    );
  end;
  perform test_assert(contact_deleted_at(v_c2) is null, 'and nothing was stamped');

  perform sign_in_as('admin_auth');
  begin
    -- 501 ids, none of them real: the ceiling is checked before anything is read.
    perform bulk_delete_records(
      'contact',
      (select array_agg(gen_random_uuid()) from generate_series(1, 501))
    );
    perform test_assert(false, 'a selection over the ceiling should be refused');
  exception when others then
    perform test_assert(sqlerrm like '%limit 500%', 'over five hundred records is refused');
  end;

  begin
    perform bulk_delete_records('deal', array[v_c2]);
    perform test_assert(false, 'only contacts and companies can be bulk deleted');
  exception when others then
    perform test_assert(sqlerrm like '%Cannot bulk delete%', 'any other entity is refused');
  end;

  perform test_assert(
    bulk_delete_records('contact', '{}'::uuid[]) = 0,
    'an empty selection is nothing to do rather than an error'
  );
end;
$$;

rollback;
