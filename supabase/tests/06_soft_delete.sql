-- =============================================================================
-- Sales tiers, soft delete, and deletion notices.
--
--   Sales director  own + unassigned; delete, import, export, reassign
--   Sales rep       own only; create, edit, delete — no bulk tools
--   Admin           the only role that sees a deleted record or restores it
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

do $$
declare
  v_org    uuid;
  v_admin_a uuid := gen_random_uuid();
  v_dir_a   uuid := gen_random_uuid();
  v_rep_a   uuid := gen_random_uuid();
  v_admin  uuid;
  v_dir    uuid;
  v_rep    uuid;
  v_mine   uuid;
  v_dirs   uuid;
  v_orphan uuid;
  v_co     uuid;
begin
  insert into organizations (name, slug) values ('Tier Co', 'tier-co') returning id into v_org;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@tier.test'), (v_dir_a, 'dir@tier.test'), (v_rep_a, 'rep@tier.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@tier.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'dir@tier.test', 'Dana', 'sales_director', v_dir_a, 'active') returning id into v_dir;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@tier.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;

  insert into companies (organization_id, name) values (v_org, 'Tier Co Ltd') returning id into v_co;

  insert into contacts (organization_id, first_name, owner_id) values (v_org, 'RepsOwn', v_rep)
  returning id into v_mine;
  insert into contacts (organization_id, first_name, owner_id) values (v_org, 'DirsOwn', v_dir)
  returning id into v_dirs;
  insert into contacts (organization_id, first_name, owner_id) values (v_org, 'Orphan', null)
  returning id into v_orphan;

  insert into fixture values
    ('org', v_org),
    ('admin_auth', v_admin_a), ('dir_auth', v_dir_a), ('rep_auth', v_rep_a),
    ('admin', v_admin), ('dir', v_dir), ('rep', v_rep),
    ('mine', v_mine), ('dirs', v_dirs), ('orphan', v_orphan), ('company', v_co);
end;
$$;

set local role authenticated;

-- =============================================================================
-- The two sales tiers differ in exactly one thing on the read side.
-- =============================================================================
do $$
begin
  raise notice 'Sales tiers:';

  perform sign_in_as('dir_auth');
  perform test_assert(
    (select count(*) from contacts where id = (select id from fixture where key = 'orphan')) = 1,
    'a sales director sees the unassigned pool'
  );
  perform test_assert(
    (select count(*) from contacts where id = (select id from fixture where key = 'mine')) = 0,
    'a sales director does not see a rep''s own book'
  );
  perform test_assert(
    (select count(*) from contacts) = 2,
    'a sales director sees their own records plus unassigned ones'
  );

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from contacts) = 1,
    'a sales rep sees only their own'
  );
end;
$$;

-- Bulk tools split along the same line.
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_failed boolean := false;
begin
  perform sign_in_as('dir_auth');

  insert into import_jobs (organization_id, entity_type, file_name, status)
  values (v_org, 'contact', 'dir.csv', 'pending');
  perform test_assert(
    (select count(*) from import_jobs) = 1,
    'a sales director can import'
  );

  perform reassign_contact(
    (select id from fixture where key = 'orphan'),
    (select id from fixture where key = 'dir')
  );
  perform test_assert(
    (select owner_id from contacts where id = (select id from fixture where key = 'orphan'))
      = (select id from fixture where key = 'dir'),
    'a sales director can assign a contact'
  );

  perform sign_in_as('rep_auth');
  begin
    insert into import_jobs (organization_id, entity_type, file_name, status)
    values (v_org, 'contact', 'rep.csv', 'pending');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a sales rep cannot import');

  perform test_assert(
    (select count(*) from import_jobs) = 0,
    'a sales rep cannot read import jobs, so export tooling stays shut too'
  );
end;
$$;

-- =============================================================================
-- Deleting is reversible, and only an administrator sees the bin.
-- =============================================================================
do $$
declare
  v_mine uuid := (select id from fixture where key = 'mine');
begin
  raise notice 'Soft delete:';

  perform sign_in_as('rep_auth');
  perform soft_delete_contact(v_mine);

  perform test_assert(
    (select count(*) from contacts where id = v_mine) = 0,
    'a deleted contact leaves the deleter''s view'
  );

  perform sign_in_as('dir_auth');
  perform test_assert(
    (select count(*) from contacts where id = v_mine) = 0,
    'a deleted contact is invisible to a sales director too'
  );

  perform sign_in_as('admin_auth');
  perform test_assert(
    (select count(*) from contacts where id = v_mine) = 1,
    'an administrator can still see the deleted contact'
  );
  perform test_assert(
    (select deleted_by from contacts where id = v_mine) = (select id from fixture where key = 'rep'),
    'the record remembers who deleted it'
  );
  perform test_assert(
    (select deleted_at from contacts where id = v_mine) is not null,
    'the record remembers when'
  );
end;
$$;

-- The row is still there — this is a stamp, not a destruction.
do $$
declare
  v_mine uuid := (select id from fixture where key = 'mine');
begin
  set local role postgres;
  perform test_assert(
    (select count(*) from contacts where id = v_mine) = 1,
    'the row was never actually destroyed'
  );
  set local role authenticated;
end;
$$;

-- Restoring is an administrator's job.
do $$
declare
  v_mine   uuid := (select id from fixture where key = 'mine');
  v_failed boolean := false;
begin
  perform sign_in_as('dir_auth');
  begin
    perform restore_contact(v_mine);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a sales director cannot restore a deleted contact');

  perform sign_in_as('admin_auth');
  perform restore_contact(v_mine);
  perform test_assert(
    (select deleted_at from contacts where id = v_mine) is null,
    'an administrator can restore it'
  );

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from contacts where id = v_mine) = 1,
    'the restored contact is back in its owner''s book'
  );
end;
$$;

-- A read-only user cannot delete at all.
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_auth   uuid := gen_random_uuid();
  v_dirs   uuid := (select id from fixture where key = 'dirs');
  v_failed boolean := false;
begin
  set local role postgres;
  insert into auth.users (id, email) values (v_auth, 'ro@tier.test');
  insert into users (organization_id, email, role, auth_provider_id, status)
  values (v_org, 'ro@tier.test', 'readonly', v_auth, 'active');
  set local role authenticated;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_auth, 'role', 'authenticated')::text, true);

  begin
    perform soft_delete_contact(v_dirs);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a read-only user cannot delete a contact');
end;
$$;

-- A deleted contact must not come back as a duplicate suggestion.
do $$
declare
  v_org  uuid := (select id from fixture where key = 'org');
  v_gone uuid;
begin
  perform sign_in_as('admin_auth');

  insert into contacts (organization_id, first_name, last_name, email, owner_id)
  values (v_org, 'Twin', 'Peaks', 'twin@tier.test', (select id from fixture where key = 'admin'))
  returning id into v_gone;

  perform test_assert(
    (select count(*) from find_duplicate_contacts('twin@tier.test', null, null, null, null)) = 1,
    'a live contact is found as a duplicate'
  );

  perform soft_delete_contact(v_gone);

  perform test_assert(
    (select count(*) from find_duplicate_contacts('twin@tier.test', null, null, null, null)) = 0,
    'a deleted contact is not suggested as a duplicate'
  );
end;
$$;

-- =============================================================================
-- Deletion raises a notice for the administrators, and nobody else.
-- =============================================================================
do $$
declare
  v_dirs uuid := (select id from fixture where key = 'dirs');
begin
  raise notice 'Deletion notices:';

  set local role postgres;
  delete from notifications;
  set local role authenticated;

  perform sign_in_as('dir_auth');
  perform soft_delete_contact(v_dirs);

  perform sign_in_as('admin_auth');
  perform test_assert(
    (select count(*) from notifications where kind = 'contact_deleted') = 1,
    'the administrator is notified that a contact was deleted'
  );
  perform test_assert(
    (select title from notifications where kind = 'contact_deleted') like '%DirsOwn%',
    'the notice names the record'
  );
  perform test_assert(
    (select body from notifications where kind = 'contact_deleted') like '%Dana%',
    'the notice names who deleted it'
  );
  perform test_assert(
    (select read_at from notifications where kind = 'contact_deleted') is null,
    'it arrives unread'
  );

  -- The deleter is not an admin, so they get nothing.
  perform sign_in_as('dir_auth');
  perform test_assert(
    (select count(*) from notifications) = 0,
    'a non-administrator sees no notifications'
  );
end;
$$;

-- Notifications are addressed, not broadcast: one person's inbox is their own.
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_admin  uuid := (select id from fixture where key = 'admin');
  v_failed boolean := false;
begin
  perform sign_in_as('dir_auth');

  -- Even writing a notification to someone else is refused; they only ever
  -- arrive from the definer functions.
  begin
    insert into notifications (organization_id, user_id, kind, title)
    values (v_org, v_admin, 'spoof', 'Fake notice');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a user cannot write a notification to someone else');
end;
$$;

-- Marking one read is the reader's own business.
do $$
begin
  perform sign_in_as('admin_auth');

  update notifications set read_at = now() where kind = 'contact_deleted';
  perform test_assert(
    (select read_at from notifications where kind = 'contact_deleted') is not null,
    'an administrator can mark their notice read'
  );
end;
$$;

-- =============================================================================
-- Companies delete the same way.
-- =============================================================================
do $$
declare
  v_co uuid := (select id from fixture where key = 'company');
begin
  raise notice 'Company deletion:';

  perform sign_in_as('rep_auth');
  perform soft_delete_company(v_co);

  perform test_assert(
    (select count(*) from companies where id = v_co) = 0,
    'a deleted company leaves everyone''s view'
  );

  perform sign_in_as('admin_auth');
  perform test_assert(
    (select count(*) from companies where id = v_co) = 1,
    'an administrator still sees it'
  );
  perform test_assert(
    (select count(*) from notifications where kind = 'company_deleted') = 1,
    'the administrator is notified'
  );

  perform restore_company(v_co);
  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from companies where id = v_co) = 1,
    'a restored company is visible again'
  );
end;
$$;

rollback;
