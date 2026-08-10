-- =============================================================================
-- Connected mailboxes.
--
--   A refresh token is a permanent key to somebody's mail. No signed-in user
--   can read one, not even their own and not even an administrator — only the
--   service role that does the polling.
--
--   Everything else about a connection is visible to its owner, and to an
--   administrator who needs to see that a mailbox has stopped syncing.
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
  v_org      uuid;
  v_other    uuid;
  v_admin_a  uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_rep2_a   uuid := gen_random_uuid();
  v_badmin_a uuid := gen_random_uuid();
  v_admin    uuid;
  v_rep      uuid;
  v_rep2     uuid;
  v_badmin   uuid;
  v_conn     uuid;
  v_conn2    uuid;
  v_bconn    uuid;
begin
  insert into organizations (name, slug) values ('Mailbox Co', 'mailbox-co') returning id into v_org;
  insert into organizations (name, slug) values ('Other Co', 'other-mailbox-co') returning id into v_other;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@mailbox.test'),
    (v_rep_a, 'rep@mailbox.test'),
    (v_rep2_a, 'rep2@mailbox.test'),
    (v_badmin_a, 'admin@other.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@mailbox.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@mailbox.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep2@mailbox.test', 'Rita', 'regular', v_rep2_a, 'active') returning id into v_rep2;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'admin@other.test', 'Bo', 'admin', v_badmin_a, 'active') returning id into v_badmin;

  -- Written the way the OAuth callback writes them: service role, token
  -- already encrypted by the application.
  insert into mailbox_connections (organization_id, user_id, email_address, refresh_token, history_id)
  values (v_org, v_rep, 'rep@mailbox.test', 'v1.aaa.bbb.ccc', '900')
  returning id into v_conn;
  insert into mailbox_connections (organization_id, user_id, email_address, refresh_token)
  values (v_org, v_rep2, 'rep2@mailbox.test', 'v1.ddd.eee.fff')
  returning id into v_conn2;
  insert into mailbox_connections (organization_id, user_id, email_address, refresh_token)
  values (v_other, v_badmin, 'admin@other.test', 'v1.ggg.hhh.iii')
  returning id into v_bconn;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_admin_a), ('rep_auth', v_rep_a),
    ('rep2_auth', v_rep2_a), ('badmin_auth', v_badmin_a),
    ('admin', v_admin), ('rep', v_rep), ('rep2', v_rep2),
    ('conn', v_conn), ('conn2', v_conn2), ('bconn', v_bconn);
end;
$$;

set local role authenticated;

-- =============================================================================
-- The token is not readable by anyone holding a user session.
-- =============================================================================
do $$
declare
  v_failed boolean := false;
  v_ignore text;
begin
  raise notice 'Refresh tokens:';

  perform sign_in_as('rep_auth');
  begin
    execute 'select refresh_token from mailbox_connections limit 1' into v_ignore;
  exception when insufficient_privilege then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'the owner of a mailbox cannot read its refresh token');

  v_failed := false;
  perform sign_in_as('admin_auth');
  begin
    execute 'select refresh_token from mailbox_connections limit 1' into v_ignore;
  exception when insufficient_privilege then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'nor can an administrator');

  -- The corollary, and the reason the app selects named columns everywhere:
  v_failed := false;
  begin
    execute 'select * from mailbox_connections limit 1';
  exception when insufficient_privilege then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'select * is refused, because it would reach the token column');
end;
$$;

-- =============================================================================
-- Everything else about a connection follows the usual visibility rules.
-- =============================================================================
do $$
begin
  raise notice 'Connection visibility:';

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from mailbox_connections) = 1,
    'a rep sees their own mailbox'
  );
  perform test_assert(
    (select email_address from mailbox_connections) = 'rep@mailbox.test',
    'and it is theirs, not a colleague''s'
  );

  perform sign_in_as('admin_auth');
  perform test_assert(
    (select count(*) from mailbox_connections) = 2,
    'an administrator sees every mailbox in the organization'
  );

  perform sign_in_as('badmin_auth');
  perform test_assert(
    (select count(*) from mailbox_connections) = 1,
    'and none of another organization''s'
  );
end;
$$;

-- =============================================================================
-- Nobody writes to the table through a session.
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_rep    uuid := (select id from fixture where key = 'rep');
  v_conn   uuid := (select id from fixture where key = 'conn');
  v_failed boolean := false;
begin
  raise notice 'Writes:';

  perform sign_in_as('admin_auth');
  begin
    insert into mailbox_connections (organization_id, user_id, email_address)
    values (v_org, v_rep, 'sneaky@mailbox.test');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'an administrator cannot hand-write a connection');

  v_failed := false;
  begin
    update mailbox_connections set status = 'active' where id = v_conn;
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'nor edit one directly — connecting goes through OAuth');
end;
$$;

-- =============================================================================
-- Disconnecting destroys the token rather than hiding it.
-- =============================================================================
do $$
declare
  v_conn   uuid := (select id from fixture where key = 'conn');
  v_conn2  uuid := (select id from fixture where key = 'conn2');
  v_bconn  uuid := (select id from fixture where key = 'bconn');
  v_failed boolean := false;
begin
  raise notice 'Disconnecting:';

  perform sign_in_as('rep2_auth');
  begin
    perform disconnect_mailbox(v_conn);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a rep cannot disconnect a colleague''s mailbox');

  v_failed := false;
  begin
    perform disconnect_mailbox(v_bconn);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'and cannot reach another organization''s at all');

  perform sign_in_as('rep_auth');
  perform disconnect_mailbox(v_conn);
  perform test_assert(
    (select status from mailbox_connections where id = v_conn) = 'disabled',
    'a rep disconnects their own'
  );
  perform test_assert(
    (select history_id from mailbox_connections where id = v_conn) is null,
    'and the sync cursor goes with it'
  );

  perform sign_in_as('admin_auth');
  perform disconnect_mailbox(v_conn2);
  perform test_assert(
    (select status from mailbox_connections where id = v_conn2) = 'disabled',
    'an administrator can disconnect anyone''s'
  );
end;
$$;

-- The token itself is gone, not merely out of sight. Checked as the owner of
-- the table, since no session can read the column.
reset role;

do $$
begin
  perform test_assert(
    (select count(*) from mailbox_connections where refresh_token is not null) = 1,
    'a disconnected mailbox keeps no token — only the untouched one still has one'
  );
end;
$$;

set local role authenticated;

-- =============================================================================
-- The backfill window is an administrator's setting.
-- =============================================================================
do $$
declare
  v_conn   uuid := (select id from fixture where key = 'conn');
  v_failed boolean := false;
begin
  raise notice 'Backfill window:';

  perform test_assert(
    (select backfill_days from mailbox_connections where id = v_conn) = 30,
    'a new connection reaches back 30 days, not to the beginning of time'
  );

  perform sign_in_as('rep_auth');
  begin
    perform set_mailbox_backfill(v_conn, 90);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a rep cannot widen it');

  perform sign_in_as('admin_auth');
  perform set_mailbox_backfill(v_conn, 90);
  perform test_assert(
    (select backfill_days from mailbox_connections where id = v_conn) = 90,
    'an administrator can'
  );

  v_failed := false;
  begin
    perform set_mailbox_backfill(v_conn, 4000);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'but not to an absurd value');
end;
$$;

rollback;
