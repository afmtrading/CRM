-- =============================================================================
-- Remembering how a list was read last time.
--
--   A profile is matched by the headings rather than the file name, upserted
--   rather than duplicated, counted so the list can be ordered by use, and kept
--   inside one organization.
--
--   The name is the one field a second save does not overwrite: somebody
--   called it "Acme buyer list" on purpose, and the file it arrives in is
--   called something different every month.
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
  v_org   uuid;
  v_other uuid;
  v_aa    uuid := gen_random_uuid();
  v_ra    uuid := gen_random_uuid();
  v_ba    uuid := gen_random_uuid();
begin
  insert into organizations (name, slug) values ('Profile Co', 'profile-co') returning id into v_org;
  insert into organizations (name, slug) values ('Their Profile Co', 'their-profile-co') returning id into v_other;

  insert into auth.users (id, email) values
    (v_aa, 'admin@profile.test'), (v_ra, 'rep@profile.test'), (v_ba, 'admin@theirprofile.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status) values
    (v_org, 'admin@profile.test', 'Ada', 'admin', v_aa, 'active'),
    -- A sales rep cannot bulk import, so cannot save a profile either.
    (v_org, 'rep@profile.test', 'Raj', 'regular', v_ra, 'active'),
    (v_other, 'admin@theirprofile.test', 'Bo', 'admin', v_ba, 'active');

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_aa), ('rep_auth', v_ra), ('badmin_auth', v_ba);
end;
$$;

set local role authenticated;

-- =============================================================================
-- Saving one, then saving it again.
-- =============================================================================
do $$
declare v_first uuid; v_second uuid;
begin
  perform sign_in_as('admin_auth');

  v_first := public.save_import_profile(
    'Acme buyer list',
    'buyer type|company / channel|country|region',
    array['Company / Channel', 'Country', 'Region', 'Buyer Type'],
    '{"Company / Channel": "company.name"}'::jsonb,
    '{"customer_type": {"PLATFORM": "Marketplace"}}'::jsonb,
    array['Company intake']);

  perform test_assert(v_first is not null, 'a profile can be saved');
  perform test_assert(
    (select times_used from import_profiles where id = v_first) = 1,
    'and starts at one use');

  -- The same headings again, with a decision changed and a different file name.
  v_second := public.save_import_profile(
    'Whatever this month''s file is called',
    'buyer type|company / channel|country|region',
    array['Company / Channel', 'Country', 'Region', 'Buyer Type'],
    '{"Company / Channel": "company.name", "Country": "company.based_in"}'::jsonb,
    '{"customer_type": {"PLATFORM": "Marketplace", "Platforms": "Marketplace"}}'::jsonb,
    array['Company intake', 'Sales team']);

  perform test_assert(v_second = v_first, 'the same headings find the same profile');
  perform test_assert(
    (select times_used from import_profiles where id = v_first) = 2,
    'and the count goes up rather than a second row appearing');
  perform test_assert(
    (select count(*) from import_profiles where organization_id = (select id from fixture where key = 'org')) = 1,
    'so there is still only one');

  perform test_assert(
    (select name from import_profiles where id = v_first) = 'Acme buyer list',
    'the name somebody chose survives — the file is called something else every month');
  perform test_assert(
    (select mapping from import_profiles where id = v_first) ? 'Country',
    'while the decisions themselves are updated');
  perform test_assert(
    (select array_length(placeholders, 1) from import_profiles where id = v_first) = 2,
    'including the placeholders');
  perform test_assert(
    (select last_used_at is not null from import_profiles where id = v_first),
    'and when it was last used');
end;
$$;

-- =============================================================================
-- Different headings are a different list.
-- =============================================================================
do $$
begin
  perform sign_in_as('admin_auth');

  perform public.save_import_profile(
    'A different list', 'email|first name|last name',
    array['First Name', 'Last Name', 'Email'],
    '{}'::jsonb, '{}'::jsonb, array[]::text[]);

  perform test_assert(
    (select count(*) from import_profiles where organization_id = (select id from fixture where key = 'org')) = 2,
    'a file with other columns gets its own profile rather than overwriting one');
end;
$$;

-- =============================================================================
-- A profile needs the columns it came from.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('admin_auth');

  begin
    perform public.save_import_profile('Nameless', '   ', array[]::text[],
      '{}'::jsonb, '{}'::jsonb, array[]::text[]);
    perform test_assert(false, 'a profile with no signature is refused');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%columns it was built from%', 'and says why');

  -- A missing name is filled in rather than refused: it is a label, not a key.
  perform public.save_import_profile('  ', 'a|b', array['A','B'],
    '{}'::jsonb, '{}'::jsonb, array[]::text[]);
  perform test_assert(
    exists (select 1 from import_profiles where name = 'Untitled list'),
    'while a missing name is filled in, because it is a label rather than a key');
end;
$$;

-- =============================================================================
-- Only somebody who may import may save one.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('rep_auth');

  begin
    perform public.save_import_profile('Sneaky', 'x|y', array['X','Y'],
      '{}'::jsonb, '{}'::jsonb, array[]::text[]);
    perform test_assert(false, 'a sales rep cannot save a profile');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%do not have permission%', 'and is told why');
end;
$$;

-- =============================================================================
-- One organization's profiles are its own.
-- =============================================================================
do $$
declare v_count integer;
begin
  perform sign_in_as('badmin_auth');

  select count(*) into v_count from import_profiles;
  perform test_assert(v_count = 0, 'another organization sees none of them');

  -- The same headings, in their organization, are their own profile.
  perform public.save_import_profile('Theirs', 'buyer type|company / channel|country|region',
    array['Company / Channel'], '{}'::jsonb, '{}'::jsonb, array[]::text[]);

  select count(*) into v_count from import_profiles;
  perform test_assert(v_count = 1, 'and the same columns do not collide across organizations');

  perform sign_in_as('admin_auth');
  perform test_assert(
    (select name from import_profiles
     where signature = 'buyer type|company / channel|country|region') = 'Acme buyer list',
    'each still sees its own');
end;
$$;

rollback;
