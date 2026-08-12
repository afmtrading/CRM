-- =============================================================================
-- Consent, suppression and unsubscribing.
--
--   Two things have to hold, and both are the kind that only bite in public:
--
--     * nobody gets mailed who shouldn't. Mailability is one view, and every
--       reason to withhold — no address, no consent, consent aged out,
--       unsubscribed, suppressed — has to actually withhold.
--
--     * an unsubscribe works for a stranger. The person clicking is not logged
--       in and belongs to no tenant; the token is the whole authorisation. It
--       must stop every record holding that address, must be permanent, and
--       must not be walkable back by a bulk edit.
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

/** Why a contact may not be mailed — null means they may. Reads past RLS. */
create or replace function blocked(p_contact uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select blocked_reason from contact_mailability where contact_id = p_contact;
$$;

create or replace function consent_of(p_contact uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select marketing_consent from contacts where id = p_contact;
$$;

create or replace function token_of(p_contact uuid)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select unsubscribe_token from contacts where id = p_contact;
$$;

grant execute on function blocked(uuid) to authenticated;
grant execute on function consent_of(uuid) to authenticated;
grant execute on function token_of(uuid) to authenticated;

do $$
declare
  v_org     uuid;
  v_other   uuid;
  v_admin_a uuid := gen_random_uuid();
  v_rep_a   uuid := gen_random_uuid();
  v_admin   uuid;
  v_rep     uuid;
  v_theirs  uuid;
begin
  insert into organizations (name, slug) values ('Consent Co', 'consent-co') returning id into v_org;
  insert into organizations (name, slug) values ('Other Consent Co', 'other-consent-co') returning id into v_other;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@consent.test'),
    (v_rep_a, 'rep@consent.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@consent.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@consent.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;

  -- The other organization's contact is made here, while still superuser: RLS
  -- would rightly refuse it later, which is the property being tested.
  insert into contacts (organization_id, first_name, email, marketing_consent, consent_at)
  values (v_other, 'Theirs', 'theirs@example.com', 'express', now())
  returning id into v_theirs;

  insert into email_suppressions (organization_id, email, reason)
  values (v_other, 'someone@theirs.example', 'manual');

  insert into fixture values
    ('org', v_org), ('other', v_other), ('theirs', v_theirs),
    ('admin_auth', v_admin_a), ('rep_auth', v_rep_a),
    ('admin', v_admin), ('rep', v_rep);
end;
$$;

-- =============================================================================
-- Who may be mailed.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
  v_own uuid := (select id from fixture where key = 'admin');
  v_id  uuid;
begin
  raise notice 'Mailability:';

  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Express', 'express@example.com', v_own, 'express', now() - interval '5 years')
  returning id into v_id;
  perform test_assert(
    blocked(v_id) is null,
    'express consent may be mailed, and does not expire with age'
  );

  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Recent', 'recent@example.com', v_own, 'implied', now() - interval '6 months')
  returning id into v_id;
  perform test_assert(blocked(v_id) is null, 'implied consent inside two years may be mailed');

  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Stale', 'stale@example.com', v_own, 'implied', now() - interval '3 years')
  returning id into v_id;
  perform test_assert(
    blocked(v_id) = 'consent_expired',
    'implied consent older than two years has aged out'
  );

  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent)
  values (v_org, 'Undated', 'undated@example.com', v_own, 'implied')
  returning id into v_id;
  perform test_assert(
    blocked(v_id) = 'consent_expired',
    'implied consent with no date counts as expired rather than assumed good'
  );

  insert into contacts (organization_id, first_name, email, owner_id)
  values (v_org, 'Nobody', 'nobody@example.com', v_own)
  returning id into v_id;
  perform test_assert(blocked(v_id) = 'no_consent', 'a new contact defaults to no consent');

  insert into contacts (organization_id, first_name, owner_id, marketing_consent, consent_at)
  values (v_org, 'Addressless', v_own, 'express', now())
  returning id into v_id;
  perform test_assert(
    blocked(v_id) = 'no_email',
    'consent without an address is still nothing to send to'
  );

  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Blank', '   ', v_own, 'express', now())
  returning id into v_id;
  perform test_assert(blocked(v_id) = 'no_email', 'and nor is a blank one');
end;
$$;

-- =============================================================================
-- Suppression beats everything.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
  v_own uuid := (select id from fixture where key = 'admin');
  v_a   uuid;
  v_b   uuid;
begin
  raise notice 'Suppression:';

  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Bounced', 'bounced@example.com', v_own, 'express', now())
  returning id into v_a;

  insert into email_suppressions (organization_id, email, reason)
  values (v_org, 'bounced@example.com', 'bounced');

  perform test_assert(
    blocked(v_a) = 'suppressed',
    'a suppressed address is withheld even with express consent'
  );

  -- The same person, entered twice, with the address cased differently.
  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Bounced Again', 'Bounced@Example.COM', v_own, 'express', now())
  returning id into v_b;

  perform test_assert(
    blocked(v_b) = 'suppressed',
    'suppression is on the address, so a duplicate record is stopped too'
  );

  perform test_assert(
    blocked((select id from contacts where email = 'express@example.com')) is null,
    'and it stops only that address, not everybody'
  );
end;
$$;

-- =============================================================================
-- Unsubscribing, by somebody who is not logged in.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_own   uuid := (select id from fixture where key = 'admin');
  v_id    uuid;
  v_twin  uuid;
  v_token uuid;
  v_check record;
begin
  raise notice 'Unsubscribing:';

  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Leaving', 'leaving@example.com', v_own, 'express', now())
  returning id into v_id;

  -- Same address on a second record, which is the case an unsubscribe most
  -- often has to cover and the one a naive implementation misses.
  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Leaving Twin', 'leaving@example.com', v_own, 'express', now())
  returning id into v_twin;

  v_token := token_of(v_id);
  perform test_assert(v_token is not null, 'every contact is given an unsubscribe token');

  select * into v_check from unsubscribe_check(v_token);
  perform test_assert(v_check.found and not v_check.already,
    'the token can be checked without unsubscribing anybody');

  perform test_assert(unsubscribe_by_token(v_token), 'the token unsubscribes');
  perform test_assert(consent_of(v_id) = 'unsubscribed', 'the contact is marked');
  perform test_assert(blocked(v_id) = 'unsubscribed', 'and is no longer mailable');
  perform test_assert(
    blocked(v_twin) = 'suppressed',
    'the other record holding that address is stopped as well'
  );

  perform test_assert(
    unsubscribe_by_token(v_token),
    'clicking the link twice is harmless'
  );

  perform test_assert(
    not unsubscribe_by_token(gen_random_uuid()),
    'and a token nobody was issued does nothing'
  );

  select * into v_check from unsubscribe_check(v_token);
  perform test_assert(v_check.already, 'a used token reports that it is already done');
end;
$$;

set local role authenticated;

-- =============================================================================
-- Recording consent in bulk — the first real job this has.
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_a      uuid;
  v_b      uuid;
  v_gone   uuid;
  v_failed boolean;
begin
  raise notice 'Recording consent in bulk:';

  perform sign_in_as('admin_auth');

  select id into v_a from contacts where email = 'nobody@example.com';
  select id into v_b from contacts where email = 'undated@example.com';
  select id into v_gone from contacts where email = 'leaving@example.com' and first_name = 'Leaving';

  perform test_assert(
    bulk_set_consent(array[v_a, v_b], 'implied', 'Existing customer since 2024') = 2,
    'consent can be recorded across several contacts at once'
  );
  perform test_assert(blocked(v_a) is null, 'and they become mailable');
  perform test_assert(
    (select consent_source from contacts where id = v_a) = 'Existing customer since 2024',
    'with the source kept, which is the part that has to be defensible later'
  );

  -- The accident this exists to prevent.
  perform test_assert(
    bulk_set_consent(array[v_gone], 'express', 'Oops') = 0,
    'somebody who unsubscribed is skipped, not quietly re-subscribed'
  );
  perform test_assert(consent_of(v_gone) = 'unsubscribed', 'they stay unsubscribed');

  v_failed := false;
  begin
    perform bulk_set_consent(array[v_a], 'unsubscribed', 'x');
  exception when others then v_failed := true;
  end;
  perform test_assert(v_failed, 'and nobody unsubscribes on another person''s behalf in bulk');

  v_failed := false;
  begin
    perform bulk_set_consent(array[v_a], 'invented', 'x');
  exception when others then v_failed := true;
  end;
  perform test_assert(v_failed, 'a consent kind nobody defined is refused');
end;
$$;

-- =============================================================================
-- One organization's consent is its own.
-- =============================================================================
do $$
declare
  v_other  uuid := (select id from fixture where key = 'other');
  v_theirs uuid := (select id from fixture where key = 'theirs');
begin
  raise notice 'Isolation:';

  perform sign_in_as('admin_auth');

  perform test_assert(
    (select count(*) from contact_mailability where contact_id = v_theirs) = 0,
    'the mailability view shows nothing from another organization'
  );

  perform test_assert(
    bulk_set_consent(array[v_theirs], 'none', 'x') = 0,
    'and their consent cannot be changed from here'
  );

  perform test_assert(
    (select count(*) from email_suppressions where organization_id = v_other) = 0,
    'nor can their suppression list be read'
  );
end;
$$;

rollback;
