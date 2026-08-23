-- =============================================================================
-- Marketing forms — the front door.
--
--   Everything here is about a caller with no session at all, which is the one
--   thing no other test in this directory exercises. So the checks are:
--
--     * anon can read a published form and nothing else — not a draft, not the
--       table, not another organization's anything;
--     * a submission becomes a contact, scored, owned and attributed, in one
--       transaction with the record of the submission itself;
--     * the same person twice is one contact, and the form never overwrites
--       what somebody in the office corrected by hand;
--     * consent is created only when it was actually given, and an unsubscribe
--       outranks a fresh tick box — the case that would otherwise turn a form
--       into a way of quietly re-subscribing people;
--     * a form that cannot produce a contact cannot go live.
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

grant execute on function test_assert(boolean, text) to authenticated, anon;

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

/** One column of a contact, read past every policy. */
create or replace function contact_text(p_contact uuid, p_column text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_value text;
begin
  execute format('select %I::text from contacts where id = $1', p_column)
  into v_value using p_contact;
  return v_value;
end;
$$;

/** The contact behind an address, whatever policies would say about it. */
create or replace function contact_for(p_org uuid, p_email text)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select id from contacts
  where organization_id = p_org and lower(email) = lower(p_email)
    and deleted_at is null and duplicate_of_id is null
  order by created_at limit 1;
$$;

grant execute on function contact_text(uuid, text) to authenticated, anon;
grant execute on function contact_for(uuid, text) to authenticated, anon;

do $$
declare
  v_org      uuid;
  v_other    uuid;
  v_admin_a  uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_bo_a     uuid := gen_random_uuid();
  v_admin    uuid;
  v_rep      uuid;
  v_bo       uuid;
  v_list     uuid;
  v_form     uuid;
  v_gone     uuid;
begin
  insert into organizations (name, slug) values ('Front Door Co', 'front-door-co')
  returning id into v_org;
  insert into organizations (name, slug) values ('Rival Doors', 'rival-doors')
  returning id into v_other;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@frontdoor.test'),
    (v_rep_a, 'rep@frontdoor.test'),
    (v_bo_a, 'bo@rival.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@frontdoor.test', 'Ada', 'admin', v_admin_a, 'active')
  returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@frontdoor.test', 'Raj', 'regular', v_rep_a, 'active')
  returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'bo@rival.test', 'Bo', 'admin', v_bo_a, 'active')
  returning id into v_bo;

  -- Every lead from this form goes to Raj, by rule rather than by name on the
  -- form, so the routing rules are what is under test.
  insert into assignment_rules (organization_id, name, strategy, source_match, fixed_user_id)
  values (v_org, 'Website to Raj', 'by_source', 'website', v_rep);

  -- A scoring rule, so the trigger can be shown to fire on a contact nobody
  -- signed in to create.
  insert into lead_score_rules (organization_id, field, condition, value, points)
  values (v_org, 'source', 'equals', 'website', 25);

  insert into email_lists (organization_id, name, source_note)
  values (v_org, 'Website signups', 'Filled in the form on the website')
  returning id into v_list;

  insert into marketing_forms (
    organization_id, name, slug, status, headline, fields,
    consent_basis, consent_label, source, list_id, notify_user_id, created_by
  )
  values (
    v_org, 'Request a quote', 'quote-abc123', 'published', 'Request a pallet quote',
    '[{"key":"name","label":"Your name","type":"text","required":true,"maps_to":"full_name"},
      {"key":"email","label":"Email address","type":"email","required":true,"maps_to":"email"},
      {"key":"company","label":"Company","type":"text","required":false,"maps_to":"company_name"},
      {"key":"pallets","label":"How many pallets?","type":"text","required":false,"maps_to":""}]'::jsonb,
    'express', 'Yes, email me offers.', 'website', v_list, v_admin, v_admin
  )
  returning id into v_form;

  insert into marketing_forms (
    organization_id, name, slug, status, headline, fields, created_by
  )
  values (
    v_org, 'Not finished', 'draft-xyz789', 'draft', 'Coming soon',
    '[{"key":"email","label":"Email","type":"email","required":true,"maps_to":"email"}]'::jsonb,
    v_admin
  )
  returning id into v_gone;

  -- Its email question is not marked required, which is the case the "needed
  -- anyway" rule exists for: a capture with no address is an anonymous note.
  insert into marketing_forms (
    organization_id, name, slug, status, headline, fields, consent_basis, created_by
  )
  values (
    v_org, 'Newsletter', 'news-def456', 'published', 'Get the stock list',
    '[{"key":"email","label":"Email","type":"email","required":false,"maps_to":"email"},
      {"key":"note","label":"Anything else?","type":"textarea","required":false,"maps_to":""}]'::jsonb,
    'none', v_admin
  );

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_admin_a), ('rep_auth', v_rep_a), ('bo_auth', v_bo_a),
    ('admin', v_admin), ('rep', v_rep), ('bo', v_bo),
    ('list', v_list), ('form', v_form), ('draft', v_gone);
end;
$$;

-- =============================================================================
-- What a stranger can reach.
-- =============================================================================
set local role anon;

do $$
declare
  v_public jsonb;
begin
  raise notice 'The anonymous surface:';

  v_public := public.marketing_form_public('quote-abc123');
  perform test_assert(v_public ->> 'headline' = 'Request a pallet quote',
    'anon can read a published form');
  perform test_assert(v_public ->> 'organization_name' = 'Front Door Co',
    'and the name of whose form it is, which is what the page prints');
  perform test_assert(v_public -> 'fields' is not null and v_public ? 'consent_label',
    'with the questions and the words of the tick box');
  perform test_assert(not (v_public ? 'list_id') and not (v_public ? 'owner_id'),
    'and nothing about where the lead is routed');

  perform test_assert(public.marketing_form_public('draft-xyz789') is null,
    'a draft is not findable by guessing its address');
  perform test_assert(public.marketing_form_public('no-such-form') is null,
    'nor is a form that does not exist');

  begin
    perform 1 from marketing_forms;
    perform test_assert(false, 'anon should not be able to read the table');
  exception when insufficient_privilege then
    perform test_assert(true, 'anon cannot read the forms table at all');
  end;

  begin
    perform 1 from marketing_form_submissions;
    perform test_assert(false, 'anon should not be able to read submissions');
  exception when insufficient_privilege then
    perform test_assert(true, 'nor the submissions');
  end;
end;
$$;

reset role;

-- =============================================================================
-- A submission becomes a contact.
-- =============================================================================
set local role anon;

do $$
declare
  v_result jsonb;
begin
  raise notice 'Capture:';

  v_result := public.submit_marketing_form(
    'quote-abc123',
    '{"name":"Mary Jane Watson","email":"MJ@Example.com","company":"Daily Bugle","pallets":"12"}'::jsonb,
    true,
    '{"page_url":"https://buyer.example/quotes","utm":{"utm_source":"linkedin"}}'::jsonb
  );

  perform test_assert(v_result ->> 'ok' = 'true', 'a complete submission is accepted');
  perform test_assert(v_result ? 'message', 'and comes back with something to show the person');
end;
$$;

reset role;

do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_rep     uuid := (select id from fixture where key = 'rep');
  v_list    uuid := (select id from fixture where key = 'list');
  v_form    uuid := (select id from fixture where key = 'form');
  v_contact uuid;
begin
  v_contact := contact_for(v_org, 'mj@example.com');
  perform test_assert(v_contact is not null, 'a stranger became a contact');
  perform test_assert(contact_text(v_contact, 'first_name') = 'Mary',
    'one name field splits on the first space');
  perform test_assert(contact_text(v_contact, 'last_name') = 'Jane Watson',
    'and everything after it is the surname');
  perform test_assert(contact_text(v_contact, 'email') = 'mj@example.com',
    'the address is stored lower-cased, so the next submission matches it');
  perform test_assert(contact_text(v_contact, 'source') = 'website',
    'the form’s source is on the contact');
  perform test_assert(contact_text(v_contact, 'lead_score') = '25',
    'and the scoring rules fired on a contact nobody signed in to create');
  perform test_assert(contact_text(v_contact, 'owner_id') = v_rep::text,
    'the by-source assignment rule chose the owner');
  perform test_assert(contact_text(v_contact, 'marketing_consent') = 'express',
    'ticking the box is what created express consent');
  perform test_assert(contact_text(v_contact, 'consent_source') = 'Form: Request a quote',
    'and the consent names the form it came from');

  perform test_assert(
    exists (select 1 from companies where organization_id = v_org and name = 'Daily Bugle'),
    'a company named on the form was created'
  );
  perform test_assert(
    (select company_id from contacts where id = v_contact)
      = (select id from companies where organization_id = v_org and name = 'Daily Bugle'),
    'and the contact is attached to it'
  );

  perform test_assert(
    exists (select 1 from email_list_members where list_id = v_list and contact_id = v_contact),
    'the contact landed on the list the form feeds'
  );

  perform test_assert(
    (select submission_count from marketing_forms where id = v_form) = 1,
    'the form counted it'
  );

  perform test_assert(
    exists (
      select 1 from activities
      where related_to_id = v_contact and external_source = 'marketing_form'
        and subject like 'Submitted the form%'
    ),
    'and it is on the contact’s timeline, where the person who has to ring them looks'
  );

  perform test_assert(
    exists (
      select 1 from notifications
      where user_id = (select id from fixture where key = 'admin') and kind = 'form_submission'
    ),
    'somebody was told'
  );
end;
$$;

-- =============================================================================
-- What was actually typed, kept.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
  v_row marketing_form_submissions%rowtype;
begin
  raise notice 'The receipt:';

  select * into v_row from marketing_form_submissions where organization_id = v_org limit 1;

  perform test_assert(v_row.consent_given, 'the submission records that the box was ticked');
  perform test_assert(v_row.consent_label = 'Yes, email me offers.',
    'and the exact words it was ticked against, frozen');
  perform test_assert(v_row.utm ->> 'utm_source' = 'linkedin', 'the campaign it came from');
  perform test_assert(v_row.page_url = 'https://buyer.example/quotes',
    'and the page it was filled in on');
  perform test_assert(
    (select count(*) from jsonb_array_elements(v_row.answers)) = 4,
    'every answer is kept, including the one that fills no field'
  );
  perform test_assert(
    exists (
      select 1 from jsonb_array_elements(v_row.answers) a
      where a ->> 'label' = 'How many pallets?' and a ->> 'value' = '12'
    ),
    'an answer carries the label as it read on the day'
  );
end;
$$;

-- =============================================================================
-- The same person twice.
-- =============================================================================
do $$
declare
  v_contact uuid := contact_for((select id from fixture where key = 'org'), 'mj@example.com');
begin
  raise notice 'Coming back:';

  -- Somebody in the office corrects the record, the way they would.
  update contacts set first_name = 'Mary Jane', last_name = 'Watson-Parker',
                      phone = '555-0100'
  where id = v_contact;
end;
$$;

set local role anon;

do $$
declare
  v_result jsonb;
begin
  v_result := public.submit_marketing_form(
    'quote-abc123',
    '{"name":"MJ","email":"mj@example.com","pallets":"40"}'::jsonb,
    true
  );

  perform test_assert(v_result ->> 'ok' = 'true', 'a second submission is accepted');
end;
$$;

reset role;

do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_contact uuid := contact_for((select id from fixture where key = 'org'), 'mj@example.com');
begin
  perform test_assert(
    (select count(*) from contacts where organization_id = v_org and lower(email) = 'mj@example.com') = 1,
    'and it is still one contact, not two'
  );
  perform test_assert(contact_text(v_contact, 'first_name') = 'Mary Jane',
    'a form does not overwrite a name somebody corrected by hand');
  perform test_assert(contact_text(v_contact, 'phone') = '555-0100',
    'nor a field it was not given');
  perform test_assert(
    (select count(*) from marketing_form_submissions where contact_id = v_contact) = 2,
    'but both submissions are kept — they are two different days'
  );
  perform test_assert(
    (select count(*) from email_list_members where contact_id = v_contact) = 1,
    'and the list holds them once'
  );
end;
$$;

-- =============================================================================
-- An unsubscribe outranks a tick box.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
begin
  raise notice 'Somebody who has already said no:';

  insert into contacts (organization_id, first_name, last_name, email, marketing_consent,
                        unsubscribed_at)
  values (v_org, 'Peter', 'Parker', 'peter@example.com', 'unsubscribed', now());
end;
$$;

set local role anon;

do $$
declare
  v_result jsonb;
begin
  v_result := public.submit_marketing_form(
    'quote-abc123',
    '{"name":"Peter Parker","email":"peter@example.com"}'::jsonb,
    true
  );

  perform test_assert(v_result ->> 'ok' = 'true',
    'the submission is still accepted — they asked for a quote');
end;
$$;

reset role;

do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_list    uuid := (select id from fixture where key = 'list');
  v_contact uuid := contact_for((select id from fixture where key = 'org'), 'peter@example.com');
begin
  perform test_assert(contact_text(v_contact, 'marketing_consent') = 'unsubscribed',
    'but a tick box does not quietly undo an unsubscribe');
  perform test_assert(
    (select consent_conflict from marketing_form_submissions
      where contact_id = v_contact order by created_at desc limit 1),
    'the submission is flagged instead, for a person to decide'
  );
  perform test_assert(
    not exists (select 1 from email_list_members where list_id = v_list and contact_id = v_contact),
    'and they were not added to the list'
  );
end;
$$;

-- =============================================================================
-- What is refused.
-- =============================================================================
set local role anon;

do $$
declare
  v_result jsonb;
begin
  raise notice 'Refusals:';

  v_result := public.submit_marketing_form('quote-abc123', '{"email":"a@b.co"}'::jsonb, false);
  perform test_assert(v_result ->> 'ok' = 'false' and v_result ->> 'error' like '%Your name%',
    'a missing required answer is refused by name');

  v_result := public.submit_marketing_form(
    'quote-abc123', '{"name":"A B","email":"not-an-address"}'::jsonb, false);
  perform test_assert(v_result ->> 'ok' = 'false' and v_result ->> 'error' like '%does not look right%',
    'so is an address that is not one');

  v_result := public.submit_marketing_form('quote-abc123', '{"name":"A B"}'::jsonb, false);
  perform test_assert(v_result ->> 'ok' = 'false' and v_result ->> 'error' like '%Email address%',
    'a required question is named in the refusal, so the person knows which one');

  -- The address is not optional even where the question is: without one there
  -- is no contact to make and no way to answer the person.
  v_result := public.submit_marketing_form('news-def456', '{"note":"hello"}'::jsonb, false);
  perform test_assert(v_result ->> 'ok' = 'false' and v_result ->> 'error' like '%email address is needed%',
    'and a submission with no address is refused even when the question was optional');

  v_result := public.submit_marketing_form('draft-xyz789', '{"email":"a@b.co"}'::jsonb, false);
  perform test_assert(v_result ->> 'ok' = 'false',
    'a draft accepts nothing, even from somebody who knows its address');

  -- A key nobody asked for is dropped rather than stored: the questions decide
  -- what a submission may contain, not the request.
  v_result := public.submit_marketing_form(
    'quote-abc123',
    '{"name":"Gwen Stacy","email":"gwen@example.com","owner_id":"whoever","lead_score":"9999"}'::jsonb,
    false
  );
  perform test_assert(v_result ->> 'ok' = 'true', 'an unexpected key does not break the submission');
end;
$$;

reset role;

do $$
begin
  perform test_assert(
    (select count(*) from jsonb_array_elements(
       (select answers from marketing_form_submissions where email = 'gwen@example.com')) ) = 2,
    'and it is not stored — only the answers to real questions are'
  );
  perform test_assert(
    contact_text(contact_for((select id from fixture where key = 'org'), 'gwen@example.com'),
                 'marketing_consent') = 'none',
    'an unticked box creates no consent'
  );
end;
$$;

-- =============================================================================
-- A form that cannot produce a contact cannot go live.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
begin
  raise notice 'Publishing:';

  begin
    insert into marketing_forms (organization_id, name, slug, status, headline, fields)
    values (v_org, 'Survey', 'survey-nomail', 'published', 'Tell us',
            '[{"key":"how","label":"How did we do?","type":"textarea","required":true,"maps_to":""}]'::jsonb);
    perform test_assert(false, 'a live form with no email question should be refused');
  exception when others then
    perform test_assert(sqlerrm like '%email address%',
      'a live form with no email question is refused');
  end;

  -- The same form is fine as a draft: half-built is a legitimate state.
  insert into marketing_forms (organization_id, name, slug, status, headline, fields)
  values (v_org, 'Survey', 'survey-nomail', 'draft', 'Tell us',
          '[{"key":"how","label":"How did we do?","type":"textarea","required":true,"maps_to":""}]'::jsonb);
  perform test_assert(true, 'but it can be saved as a draft while it is being written');

  begin
    insert into marketing_forms (organization_id, name, slug, status, headline, fields)
    values (v_org, 'Two mails', 'two-mails-1', 'draft', 'Hello',
            '[{"key":"a","label":"Email","type":"email","required":true,"maps_to":"email"},
              {"key":"b","label":"Confirm email","type":"email","required":true,"maps_to":"email"}]'::jsonb);
    perform test_assert(false, 'two questions filling one field should be refused');
  exception when others then
    perform test_assert(sqlerrm like '%both fill%', 'two questions cannot fill the same field');
  end;

  begin
    insert into marketing_forms (organization_id, name, slug, status, headline, fields)
    values (v_org, 'Sneaky', 'sneaky-form-1', 'draft', 'Hello',
            '[{"key":"o","label":"Owner","type":"text","required":false,"maps_to":"owner_id"}]'::jsonb);
    perform test_assert(false, 'a question filling the owner should be refused');
  exception when others then
    perform test_assert(sqlerrm like '%cannot fill%',
      'a question cannot fill a column outside the whitelist');
  end;

  begin
    insert into marketing_forms (organization_id, name, slug, status, headline, fields)
    values (v_org, 'Bad address', 'Not A Slug!', 'draft', 'Hello', '[]'::jsonb);
    perform test_assert(false, 'a slug with capitals and punctuation should be refused');
  exception when others then
    perform test_assert(sqlerrm like '%lower-case%', 'the public address is checked on write');
  end;
end;
$$;

-- =============================================================================
-- One address, across the whole installation.
-- =============================================================================
do $$
declare
  v_other uuid := (select id from fixture where key = 'other');
begin
  raise notice 'Addresses:';

  begin
    insert into marketing_forms (organization_id, name, slug, status, headline, fields)
    values (v_other, 'Their quote form', 'quote-abc123', 'draft', 'Quote', '[]'::jsonb);
    perform test_assert(false, 'another organization should not be able to take the same address');
  exception when unique_violation then
    perform test_assert(true,
      'a slug is unique across every organization — the URL carries no tenant');
  end;
end;
$$;

-- =============================================================================
-- Tenancy.
-- =============================================================================
set local role authenticated;

do $$
begin
  raise notice 'Tenancy:';

  perform sign_in_as('bo_auth');
  perform test_assert(
    (select count(*) from marketing_forms) = 0,
    'a rival organization sees none of these forms'
  );
  perform test_assert(
    (select count(*) from marketing_form_submissions) = 0,
    'and none of the submissions'
  );

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from marketing_forms) > 0,
    'somebody in the organization sees them'
  );

  -- Submissions are evidence. Nobody in the office writes one, edits one, or
  -- tidies one away — the whole value of the row is that it was not touched.
  begin
    insert into marketing_form_submissions (organization_id, form_id, answers)
    values ((select id from fixture where key = 'org'),
            (select id from fixture where key = 'form'), '[]'::jsonb);
    perform test_assert(false, 'a submission should not be insertable by hand');
  exception when insufficient_privilege then
    perform test_assert(true, 'a submission cannot be written by hand');
  end;

  begin
    delete from marketing_form_submissions;
    perform test_assert(false, 'a submission should not be deletable by hand');
  exception when insufficient_privilege then
    perform test_assert(true, 'nor deleted');
  end;
end;
$$;

reset role;

rollback;
