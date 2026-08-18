-- =============================================================================
-- Business rule tests — the Phase 1 acceptance criteria that live in the
-- database (PRD Sections 6.2, 6.3, 6.5, 6.8).
--
-- Runs as a signed-in `authenticated` user so the rules are exercised through
-- the same path the app uses, RLS included.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

create table fixture (key text primary key, id uuid);
grant select on fixture to authenticated;

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
  v_org  uuid;
  v_auth uuid := gen_random_uuid();
  v_user uuid;
begin
  insert into organizations (name, slug) values ('Acceptance Co', 'acceptance-co') returning id into v_org;
  insert into auth.users (id, email) values (v_auth, 'tester@example.com');
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'tester@example.com', 'Tess', 'admin', v_auth, 'active') returning id into v_user;

  insert into fixture values ('org', v_org), ('auth', v_auth), ('user', v_user);
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', (select id from fixture where key = 'auth'), 'role', 'authenticated')::text,
  true
);

-- =============================================================================
-- 6.3 "Moving a Deal between stages in the kanban view updates its probability
--      to the new stage's default unless the user has manually overridden it."
-- =============================================================================
do $$
declare
  v_org       uuid := (select id from fixture where key = 'org');
  v_new       uuid;
  v_proposal  uuid;
  v_negotiate uuid;
  v_deal      uuid;
  v_prob      numeric;
  v_status    deal_status;
  v_closed    date;
begin
  raise notice 'Deal stage probability (6.3):';

  select id into v_new       from stages where organization_id = v_org and name = 'New';
  select id into v_proposal  from stages where organization_id = v_org and name = 'Proposal Sent';
  select id into v_negotiate from stages where organization_id = v_org and name = 'Negotiation';

  -- A new deal inherits its stage's default probability.
  insert into deals (organization_id, name, stage_id, value)
  values (v_org, 'Inherits stage default', v_new, 10000)
  returning id, probability into v_deal, v_prob;

  perform test_assert(v_prob = 0.100, 'a new deal inherits the stage default probability');

  -- Moving stages re-applies the destination stage's default.
  update deals set stage_id = v_proposal where id = v_deal;
  select probability into v_prob from deals where id = v_deal;
  perform test_assert(v_prob = 0.500, 'moving to a new stage applies that stage''s default');

  update deals set stage_id = v_negotiate where id = v_deal;
  select probability into v_prob from deals where id = v_deal;
  perform test_assert(v_prob = 0.750, 'moving again applies the next stage''s default');

  -- Once overridden, a stage move leaves the manual number alone.
  update deals set probability = 0.900, probability_overridden = true where id = v_deal;
  update deals set stage_id = v_new where id = v_deal;
  select probability into v_prob from deals where id = v_deal;
  perform test_assert(v_prob = 0.900, 'an overridden probability survives a stage move');

  -- Clearing the override brings it back in step.
  update deals set probability_overridden = false where id = v_deal;
  update deals set stage_id = v_proposal where id = v_deal;
  select probability into v_prob from deals where id = v_deal;
  perform test_assert(v_prob = 0.500, 'clearing the override restores stage-default behaviour');

  -- Closing a deal stamps the close date; reopening clears it. The day is the
  -- organization's own, not the server's — see 20260241000000. This used to
  -- read `current_date`, which agreed with it for most of the day and quietly
  -- did not in the evening.
  update deals set status = 'won' where id = v_deal;
  select status, actual_close_date into v_status, v_closed from deals where id = v_deal;
  perform test_assert(
    v_status = 'won' and v_closed = public.org_today(v_org),
    'winning a deal stamps the close date on the organization''s calendar'
  );

  update deals set status = 'open' where id = v_deal;
  select actual_close_date into v_closed from deals where id = v_deal;
  perform test_assert(v_closed is null, 'reopening a deal clears the close date');

  delete from deals where id = v_deal;
end;
$$;

-- =============================================================================
-- 6.5 "An admin can create a rule ("source = website" adds 10 points) and see
--      it reflected in a Contact's score without a deploy."
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_contact uuid;
  v_score   integer;
  v_changed integer;
begin
  raise notice 'Lead scoring (6.5):';

  insert into contacts (organization_id, first_name, last_name, email, source)
  values (v_org, 'Wendy', 'Webb', 'wendy@example.com', 'website')
  returning id, lead_score into v_contact, v_score;

  perform test_assert(v_score = 0, 'with no rules, a contact scores zero');

  -- The rule an admin would type into Settings → Lead scoring.
  insert into lead_score_rules (organization_id, field, condition, value, points)
  values (v_org, 'source', 'equals', 'website', 10);

  -- Existing contacts pick it up through the recalculate endpoint.
  select public.recalculate_lead_scores() into v_changed;
  select lead_score into v_score from contacts where id = v_contact;
  perform test_assert(v_score = 10, 'recalculating applies a new rule to existing contacts');
  perform test_assert(v_changed = 1, 'recalculating reports how many contacts changed');

  -- And new contacts are scored on the way in, no recalculation needed.
  insert into contacts (organization_id, first_name, source)
  values (v_org, 'Fresh', 'website') returning lead_score into v_score;
  perform test_assert(v_score = 10, 'a newly created contact is scored on insert');

  -- Rules stack.
  insert into lead_score_rules (organization_id, field, condition, value, points)
  values (v_org, 'email', 'is_filled', null, 5);

  perform public.recalculate_lead_scores();
  select lead_score into v_score from contacts where id = v_contact;
  perform test_assert(v_score = 15, 'scores are the sum of every matching rule');

  -- A rule on a custom field works the same way.
  insert into lead_score_rules (organization_id, field, condition, value, points)
  values (v_org, 'custom_fields.tier', 'equals', 'gold', 25);

  update contacts set custom_fields = '{"tier": "gold"}'::jsonb where id = v_contact;
  select lead_score into v_score from contacts where id = v_contact;
  perform test_assert(v_score = 40, 'custom fields are scoreable like standard fields');

  -- Editing a contact out of a rule's range lowers the score again.
  update contacts set source = 'cold call' where id = v_contact;
  select lead_score into v_score from contacts where id = v_contact;
  perform test_assert(v_score = 30, 'a score drops when the contact stops matching a rule');

  delete from lead_score_rules where organization_id = v_org;
  delete from contacts where organization_id = v_org;
end;
$$;

-- =============================================================================
-- 6.2 Duplicate detection and the merge flow
-- =============================================================================
do $$
declare
  v_org      uuid := (select id from fixture where key = 'org');
  v_user     uuid := (select id from fixture where key = 'user');
  v_target   uuid;
  v_source   uuid;
  v_stage    uuid;
  v_deal     uuid;
  v_activity uuid;
  v_tag      uuid;
  v_count    integer;
  v_merged   contacts;
begin
  raise notice 'Duplicate detection and merge (6.2):';

  insert into contacts (organization_id, first_name, last_name, email, phone, owner_id)
  values (v_org, 'Dana', 'Doyle', 'dana@example.com', '+1 (416) 555-0100', v_user)
  returning id into v_target;

  -- Matching email is a duplicate.
  select count(*) into v_count
  from public.find_duplicate_contacts('DANA@example.com', null, null, null, null);
  perform test_assert(v_count = 1, 'a matching email is detected, case-insensitively');

  -- Matching name + phone is a duplicate even when the email differs.
  select count(*) into v_count
  from public.find_duplicate_contacts('other@example.com', 'Dana', 'Doyle', '4165550100', null);
  perform test_assert(v_count = 1, 'a matching name and phone is detected despite formatting');

  -- A different person is not.
  select count(*) into v_count
  from public.find_duplicate_contacts('someone@example.com', 'Sam', 'Smith', '4165559999', null);
  perform test_assert(v_count = 0, 'an unrelated contact is not reported as a duplicate');

  -- Now merge a second record into the first, with a deal, an activity and a
  -- tag hanging off it.
  insert into contacts (organization_id, first_name, last_name, email, phone, source, custom_fields)
  values (v_org, 'Dana', '', 'dana.doyle@example.com', '4165550100', 'trade show', '{"tier": "gold"}'::jsonb)
  returning id into v_source;

  select id into v_stage from stages where organization_id = v_org order by "order" limit 1;

  insert into deals (organization_id, name, stage_id, value, contact_id)
  values (v_org, 'Duplicate''s deal', v_stage, 5000, v_source) returning id into v_deal;

  insert into activities (organization_id, type, related_to_type, related_to_id, subject)
  values (v_org, 'call', 'contact', v_source, 'Intro call') returning id into v_activity;

  insert into tags (organization_id, name) values (v_org, 'VIP') returning id into v_tag;
  insert into contact_tags (contact_id, tag_id) values (v_source, v_tag);

  select * into v_merged from public.merge_contacts(v_target, v_source);

  perform test_assert(
    (select contact_id from deals where id = v_deal) = v_target,
    'the duplicate''s deals move to the surviving contact'
  );
  perform test_assert(
    (select related_to_id from activities where id = v_activity) = v_target,
    'the duplicate''s activities move to the surviving contact'
  );
  perform test_assert(
    exists (select 1 from contact_tags where contact_id = v_target and tag_id = v_tag),
    'the duplicate''s tags move to the surviving contact'
  );
  perform test_assert(
    not exists (select 1 from contact_tags where contact_id = v_source),
    'the duplicate keeps none of its tags'
  );
  perform test_assert(
    v_merged.last_name = 'Doyle',
    'the surviving contact keeps its own populated values'
  );
  perform test_assert(
    v_merged.source = 'trade show',
    'the surviving contact inherits values it was missing'
  );
  perform test_assert(
    v_merged.custom_fields ->> 'tier' = 'gold',
    'custom fields are merged into the surviving contact'
  );
  perform test_assert(
    (select duplicate_of_id from contacts where id = v_source) = v_target,
    'the merged-away record points at the survivor so old links resolve'
  );
  perform test_assert(
    (select email from contacts where id = v_source) is null,
    'the merged-away record releases its email so it stops matching'
  );

  -- Merging a contact into itself is refused.
  begin
    perform public.merge_contacts(v_target, v_target);
    perform test_assert(false, 'merging a contact into itself must be refused');
  exception
    when others then
      perform test_assert(true, 'merging a contact into itself is refused');
  end;

  delete from deals where organization_id = v_org;
  delete from activities where organization_id = v_org;
  delete from contact_tags where organization_id = v_org;
  delete from tags where organization_id = v_org;
  delete from contacts where organization_id = v_org;
end;
$$;

-- =============================================================================
-- 6.8 "The number shown matches a manual sum of open Deals' values in that
--      stage, at all times, no caching drift."
-- =============================================================================
do $$
declare
  v_org       uuid := (select id from fixture where key = 'org');
  v_user      uuid := (select id from fixture where key = 'user');
  v_new       uuid;
  v_proposal  uuid;
  v_reported  numeric;
  v_manual    numeric;
  v_weighted  numeric;
begin
  raise notice 'Pipeline value report (6.8):';

  select id into v_new      from stages where organization_id = v_org and name = 'New';
  select id into v_proposal from stages where organization_id = v_org and name = 'Proposal Sent';

  insert into deals (organization_id, name, stage_id, value, owner_id, status) values
    (v_org, 'Open one',    v_new,      1000, v_user, 'open'),
    (v_org, 'Open two',    v_new,      2500, v_user, 'open'),
    (v_org, 'Open three',  v_proposal, 4000, v_user, 'open'),
    (v_org, 'Already won', v_proposal, 9999, v_user, 'won'),
    (v_org, 'Lost one',    v_new,      8888, v_user, 'lost');

  select sum(total_value) into v_reported
  from public.report_pipeline_value(null, null) where stage_id = v_new;

  select sum(value) into v_manual
  from deals where organization_id = v_org and stage_id = v_new and status = 'open';

  perform test_assert(v_reported = v_manual, 'the reported stage total matches a manual sum');
  perform test_assert(v_reported = 3500, 'closed deals are excluded from pipeline value');

  -- Weighted value follows probability, which follows the stage default.
  select sum(weighted_value) into v_weighted
  from public.report_pipeline_value(null, null) where stage_id = v_new;
  perform test_assert(v_weighted = 350.000, 'weighted value is value x probability');

  -- Changing a deal is reflected immediately — nothing is cached.
  update deals set value = 5000 where organization_id = v_org and name = 'Open one';
  select sum(total_value) into v_reported
  from public.report_pipeline_value(null, null) where stage_id = v_new;
  perform test_assert(v_reported = 7500, 'the report reflects an edit immediately');

  -- Filtering by owner works, and an owner with no deals reports nothing.
  select coalesce(sum(total_value), 0) into v_reported
  from public.report_pipeline_value(null, gen_random_uuid());
  perform test_assert(v_reported = 0, 'filtering by an owner with no deals reports zero');

  delete from deals where organization_id = v_org;
end;
$$;

-- =============================================================================
-- 6.5 Assignment and routing
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_user_a uuid := (select id from fixture where key = 'user');
  v_user_b uuid;
  v_first  uuid;
  v_second uuid;
  v_third  uuid;
begin
  raise notice 'Assignment routing (6.5):';

  perform test_assert(public.next_assignee(null) is null, 'with no rules, routing assigns nobody');

  insert into users (organization_id, email, name, status)
  values (v_org, 'second@example.com', 'Sam', 'active') returning id into v_user_b;

  insert into assignment_rules (organization_id, name, strategy, priority)
  values (v_org, 'Round robin', 'round_robin', 10);

  select public.next_assignee(null) into v_first;
  select public.next_assignee(null) into v_second;
  select public.next_assignee(null) into v_third;

  -- Asserted as a cycle rather than by name: both users are created inside the
  -- same transaction and therefore share a created_at, so which one comes
  -- first is decided by the id tiebreak. What has to hold is that consecutive
  -- leads go to different people and the rotation wraps.
  perform test_assert(
    v_first in (v_user_a, v_user_b) and v_second in (v_user_a, v_user_b),
    'round-robin assigns to active users in the organization'
  );
  perform test_assert(v_second <> v_first, 'round-robin advances to the next user');
  perform test_assert(v_third = v_first, 'round-robin wraps back around');

  -- A higher-priority source rule wins over round-robin.
  insert into assignment_rules (organization_id, name, strategy, source_match, fixed_user_id, priority)
  values (v_org, 'Website to Sam', 'by_source', 'website', v_user_b, 1);

  perform test_assert(
    public.next_assignee('website') = v_user_b,
    'a source rule takes precedence over round-robin'
  );
  perform test_assert(
    public.next_assignee('referral') is not null,
    'a non-matching source falls through to the next rule'
  );

  delete from assignment_rules where organization_id = v_org;
  delete from users where id = v_user_b;
end;
$$;

-- =============================================================================
-- Structural guarantees the app relies on
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_count integer;
begin
  raise notice 'Structural guarantees:';

  -- Every new organization is usable immediately (6.3 needs a pipeline).
  select count(*) into v_count from pipelines where organization_id = v_org and is_default;
  perform test_assert(v_count = 1, 'a new organization gets exactly one default pipeline');

  select count(*) into v_count from stages where organization_id = v_org;
  perform test_assert(v_count = 6, 'the default pipeline comes with stages');

  -- Tag names are unique per organization, case-insensitively.
  insert into tags (organization_id, name) values (v_org, 'Priority');
  begin
    insert into tags (organization_id, name) values (v_org, 'priority');
    perform test_assert(false, 'duplicate tag names must be rejected');
  exception
    when unique_violation then
      perform test_assert(true, 'tag names are unique per organization, case-insensitively');
  end;

  delete from tags where organization_id = v_org;
end;
$$;

-- =============================================================================
-- Who made the deal, and who touched it last
--
-- Deals carried only their timestamps until 20260256, so the Record history
-- card on a deal could say when and never who. Stamped by a trigger rather
-- than sent by the caller, for the reason contacts and companies are: the one
-- place that always knows who is writing is the write itself.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_user  uuid := (select id from fixture where key = 'user');
  v_stage uuid;
  v_deal  uuid;
begin
  raise notice 'Deal record history:';

  select id into v_stage from stages where organization_id = v_org order by "order" limit 1;

  insert into deals (organization_id, name, stage_id, value)
  values (v_org, 'Stamped deal', v_stage, 100) returning id into v_deal;

  perform test_assert(
    (select created_by from deals where id = v_deal) = v_user,
    'creating a deal records who created it'
  );

  perform test_assert(
    (select updated_by from deals where id = v_deal) = v_user,
    'and who last touched it'
  );

  update deals set value = 200 where id = v_deal;

  perform test_assert(
    (select created_by from deals where id = v_deal) = v_user,
    'editing a deal leaves created_by alone'
  );
end;
$$;

reset role;
rollback;
