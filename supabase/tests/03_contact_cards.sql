-- =============================================================================
-- Contact detail card tests.
--
-- Covers the pieces of the contact-card work that live in the database: the
-- per-organization option lists behind the coloured select fields, the
-- created-by / updated-by stamping, and the birthday reminder job.
--
-- Runs as a signed-in `authenticated` user, so RLS is exercised too.
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

do $$
declare
  v_org_a  uuid;
  v_org_b  uuid;
  v_auth_a uuid := gen_random_uuid();
  v_auth_b uuid := gen_random_uuid();
  v_user_a uuid;
  v_user_b uuid;
begin
  insert into organizations (name, slug) values ('Cards A', 'cards-a') returning id into v_org_a;
  insert into organizations (name, slug) values ('Cards B', 'cards-b') returning id into v_org_b;

  insert into auth.users (id, email) values (v_auth_a, 'a@cards.test'), (v_auth_b, 'b@cards.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org_a, 'a@cards.test', 'Ada', 'admin', v_auth_a, 'active') returning id into v_user_a;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org_b, 'b@cards.test', 'Bo', 'admin', v_auth_b, 'active') returning id into v_user_b;

  insert into fixture values
    ('org_a', v_org_a), ('org_b', v_org_b),
    ('auth_a', v_auth_a), ('auth_b', v_auth_b),
    ('user_a', v_user_a), ('user_b', v_user_b);
end;
$$;

-- =============================================================================
-- Option lists: seeded for every organization, and isolated between them.
-- =============================================================================
do $$
declare
  v_org_a uuid := (select id from fixture where key = 'org_a');
  v_org_b uuid := (select id from fixture where key = 'org_b');
begin
  raise notice 'Select field options:';

  perform test_assert(
    (select count(*) from field_options where organization_id = v_org_a and field_key = 'priority') = 4,
    'a new organization is seeded with the priority options'
  );

  -- Six for people and businesses — market, company type, stock type, role
  -- type, priority, credibility — three more for the catalogue, one for why a
  -- deal was lost. Not product_category, which is seeded empty on purpose: an
  -- organization's own categories are not a list this app can guess.
  perform test_assert(
    (select count(distinct field_key) from field_options where organization_id = v_org_a) = 10,
    'every option list with a starting vocabulary is seeded'
  );

  perform test_assert(
    (select count(*) from field_options
     where organization_id = v_org_a and entity_type = 'deal' and field_key = 'loss_reason') = 8,
    'a new organization is seeded with loss reasons'
  );

  perform test_assert(
    (select count(*) from field_options where organization_id = v_org_a)
      = (select count(*) from field_options where organization_id = v_org_b),
    'each organization gets its own copy of the lists'
  );

  perform test_assert(
    (select color from field_options
      where organization_id = v_org_a and field_key = 'priority' and value = 'Critical') = 'red',
    'an option carries its own colour'
  );

  -- Editing one organization's list must not touch another's.
  update field_options set value = 'Urgent'
  where organization_id = v_org_a and field_key = 'priority' and value = 'Critical';

  perform test_assert(
    exists (select 1 from field_options
      where organization_id = v_org_b and field_key = 'priority' and value = 'Critical'),
    'renaming an option in one organization leaves the other untouched'
  );

  update field_options set value = 'Critical'
  where organization_id = v_org_a and field_key = 'priority' and value = 'Urgent';
end;
$$;

-- A colour outside the palette is refused: the UI maps colours onto Tailwind
-- classes that must exist at build time, so an arbitrary value would render
-- as no colour at all.
do $$
declare
  v_org_a uuid := (select id from fixture where key = 'org_a');
  v_failed boolean := false;
begin
  begin
    insert into field_options (organization_id, field_key, value, color)
    values (v_org_a, 'priority', 'Chartreuse', 'chartreuse');
  exception when check_violation then
    v_failed := true;
  end;

  perform test_assert(v_failed, 'a colour outside the palette is rejected');
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', (select id from fixture where key = 'auth_a'), 'role', 'authenticated')::text,
  true
);

do $$
declare
  v_org_b uuid := (select id from fixture where key = 'org_b');
begin
  perform test_assert(
    (select count(*) from field_options where organization_id = v_org_b) = 0,
    'a signed-in user cannot read another organization''s option lists'
  );
end;
$$;

-- =============================================================================
-- Created by / updated by stamping.
-- =============================================================================
do $$
declare
  v_org_a  uuid := (select id from fixture where key = 'org_a');
  v_user_a uuid := (select id from fixture where key = 'user_a');
  v_contact uuid;
begin
  raise notice 'Record history:';

  insert into contacts (organization_id, first_name, last_name, email)
  values (v_org_a, 'Nadia', 'Haddad', 'nadia@cards.test')
  returning id into v_contact;

  insert into fixture values ('contact', v_contact);

  perform test_assert(
    (select created_by from contacts where id = v_contact) = v_user_a,
    'creating a contact records who created it'
  );

  perform test_assert(
    (select updated_by from contacts where id = v_contact) = v_user_a,
    'creating a contact also records who last touched it'
  );

  perform test_assert(
    (select job_title from contacts where id = v_contact) is null
    and (select links from contacts where id = v_contact) = '[]'::jsonb,
    'the new card columns default to empty rather than failing the insert'
  );
end;
$$;

-- A second user's edit re-stamps updated_by but leaves created_by alone.
do $$
declare
  v_org_a   uuid := (select id from fixture where key = 'org_a');
  v_contact uuid := (select id from fixture where key = 'contact');
  v_auth_c  uuid := gen_random_uuid();
  v_user_c  uuid;
begin
  set local role postgres;

  insert into auth.users (id, email) values (v_auth_c, 'c@cards.test');
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org_a, 'c@cards.test', 'Cyrus', 'regular', v_auth_c, 'active')
  returning id into v_user_c;

  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_auth_c, 'role', 'authenticated')::text,
    true
  );

  update contacts set job_title = 'Head of Purchasing' where id = v_contact;

  perform test_assert(
    (select updated_by from contacts where id = v_contact) = v_user_c,
    'editing a contact records the editor, not the creator'
  );

  perform test_assert(
    (select created_by from contacts where id = v_contact) = (select id from fixture where key = 'user_a'),
    'editing a contact leaves created_by alone'
  );
end;
$$;

-- =============================================================================
-- Birthday reminders: a task three days before, exactly once.
-- =============================================================================
set local role postgres;

do $$
declare
  v_org_a   uuid := (select id from fixture where key = 'org_a');
  v_user_a  uuid := (select id from fixture where key = 'user_a');
  v_in3     uuid;
  v_in10    uuid;
  v_rollover uuid;
  v_created integer;
begin
  raise notice 'Birthday reminders:';

  -- Born on a date whose anniversary falls three days from today.
  insert into contacts (organization_id, first_name, last_name, owner_id, birthday)
  values (v_org_a, 'Yusuf', 'Karim', v_user_a, make_date(1980,
    extract(month from current_date + 3)::int, extract(day from current_date + 3)::int))
  returning id into v_in3;

  -- Ten days out: not due yet.
  insert into contacts (organization_id, first_name, last_name, owner_id, birthday)
  values (v_org_a, 'Lena', 'Fischer', v_user_a, make_date(1975,
    extract(month from current_date + 10)::int, extract(day from current_date + 10)::int))
  returning id into v_in10;

  v_created := create_birthday_reminders(3);

  perform test_assert(v_created = 1, 'exactly one reminder is created for the birthday three days out');

  perform test_assert(
    exists (
      select 1 from activities
      where related_to_id = v_in3 and type = 'task' and external_source = 'birthday'
    ),
    'the reminder is a task on the contact'
  );

  perform test_assert(
    (select owner_id from activities where related_to_id = v_in3 and external_source = 'birthday')
      = v_user_a,
    'the reminder is owned by whoever owns the contact'
  );

  perform test_assert(
    (select due_date::date from activities
      where related_to_id = v_in3 and external_source = 'birthday') = current_date + 3,
    'the reminder is due on the birthday itself'
  );

  perform test_assert(
    not exists (select 1 from activities where related_to_id = v_in10 and external_source = 'birthday'),
    'a birthday ten days out is not reminded about yet'
  );

  -- Running the job again the same day must not produce a second task.
  v_created := create_birthday_reminders(3);
  perform test_assert(v_created = 0, 'running the job again creates nothing new');

  perform test_assert(
    (select count(*) from activities where related_to_id = v_in3 and external_source = 'birthday') = 1,
    'the contact still has exactly one birthday task'
  );

  -- A birthday that has already passed this year rolls to next year rather
  -- than being treated as overdue — the case that breaks a naive date diff.
  insert into contacts (organization_id, first_name, last_name, owner_id, birthday)
  values (v_org_a, 'Omar', 'Said', v_user_a, current_date - interval '40 days')
  returning id into v_rollover;

  perform test_assert(
    create_birthday_reminders(3) = 0,
    'a birthday that already passed this year is not reminded about now'
  );

  -- ...and is picked up when its next anniversary comes around.
  perform test_assert(
    (select count(*) from contacts where id = v_rollover and birthday < current_date) = 1,
    'the rolled-over contact is still stored with its original birth date'
  );
end;
$$;

-- A contact merged away should not generate reminders.
do $$
declare
  v_org_a  uuid := (select id from fixture where key = 'org_a');
  v_user_a uuid := (select id from fixture where key = 'user_a');
  v_target uuid;
  v_dupe   uuid;
begin
  insert into contacts (organization_id, first_name, owner_id)
  values (v_org_a, 'Survivor', v_user_a) returning id into v_target;

  insert into contacts (organization_id, first_name, owner_id, birthday, duplicate_of_id)
  values (v_org_a, 'Tombstone', v_user_a, make_date(1990,
    extract(month from current_date + 3)::int, extract(day from current_date + 3)::int), v_target)
  returning id into v_dupe;

  perform test_assert(
    create_birthday_reminders(3) = 0,
    'a merged-away contact does not generate a birthday reminder'
  );
end;
$$;

-- =============================================================================
-- Custom fields carry the card they belong to.
-- =============================================================================
do $$
declare
  v_org_a uuid := (select id from fixture where key = 'org_a');
  v_failed boolean := false;
begin
  raise notice 'Custom field placement:';

  insert into custom_field_definitions (organization_id, entity_type, key, label, field_type, card)
  values (v_org_a, 'contact', 'territory', 'Territory', 'multiselect', 'influence');

  perform test_assert(
    (select card from custom_field_definitions
      where organization_id = v_org_a and key = 'territory') = 'influence',
    'a custom field remembers which card it belongs to'
  );

  perform test_assert(
    (select card from custom_field_definitions
      where organization_id = v_org_a and key = 'territory') is not null,
    'card is never null, so a field always has somewhere to render'
  );

  begin
    insert into custom_field_definitions (organization_id, entity_type, key, label, card)
    values (v_org_a, 'contact', 'stray', 'Stray', 'nowhere');
  exception when check_violation then
    v_failed := true;
  end;

  perform test_assert(v_failed, 'a card name outside the known set is rejected');
end;
$$;

rollback;
