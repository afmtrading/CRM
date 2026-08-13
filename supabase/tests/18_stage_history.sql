-- =============================================================================
-- Where a deal has been.
--
--   Every arrival in a stage is recorded, by a trigger, at the moment it
--   happens. Nobody can write or edit that record by hand — a history somebody
--   can edit is not a history.
--
--   Time in stage is derived from two rows rather than stored beside them.
--
--   The funnel counts deals that ever *arrived* in a stage, and refuses to
--   count the backfilled rows written for deals that predate the table.
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
  v_mgr_a    uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_rep2_a   uuid := gen_random_uuid();
  v_mgr      uuid;
  v_rep      uuid;
  v_rep2     uuid;
  v_pipeline uuid;
  v_quote    uuid;
  v_proposal uuid;
  v_won      uuid;
  v_lost     uuid;
begin
  insert into organizations (name, slug) values ('History Co', 'history-co') returning id into v_org;

  insert into auth.users (id, email) values
    (v_mgr_a, 'mgr@history.test'),
    (v_rep_a, 'rep@history.test'),
    (v_rep2_a, 'rep2@history.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'mgr@history.test', 'Mo', 'manager', v_mgr_a, 'active') returning id into v_mgr;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@history.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep2@history.test', 'Rita', 'regular', v_rep2_a, 'active') returning id into v_rep2;

  insert into pipelines (organization_id, name, is_default)
  values (v_org, 'Quotes', false) returning id into v_pipeline;

  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_pipeline, 'Quote', 0, 0.25) returning id into v_quote;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_pipeline, 'Proposal', 1, 0.60) returning id into v_proposal;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability, outcome)
  values (v_org, v_pipeline, 'Won', 2, 1, 'won') returning id into v_won;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability, outcome)
  values (v_org, v_pipeline, 'Lost', 3, 0, 'lost') returning id into v_lost;

  insert into fixture values
    ('org', v_org),
    ('mgr_auth', v_mgr_a), ('rep_auth', v_rep_a), ('rep2_auth', v_rep2_a),
    ('mgr', v_mgr), ('rep', v_rep), ('rep2', v_rep2),
    ('pipeline', v_pipeline),
    ('quote', v_quote), ('proposal', v_proposal), ('won', v_won), ('lost', v_lost);
end;
$$;

set local role authenticated;

-- =============================================================================
-- Every arrival is recorded.
-- =============================================================================
do $$
declare
  v_org      uuid := (select id from fixture where key = 'org');
  v_quote    uuid := (select id from fixture where key = 'quote');
  v_proposal uuid := (select id from fixture where key = 'proposal');
  v_won      uuid := (select id from fixture where key = 'won');
  v_rep      uuid := (select id from fixture where key = 'rep');
  v_deal     uuid;
  v_row      record;
begin
  raise notice 'Recording the path:';

  perform sign_in_as('rep_auth');

  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Journey', v_quote, 1000, 'USD', v_rep) returning id into v_deal;
  insert into fixture values ('deal', v_deal);

  perform test_assert(
    (select count(*) from deal_stage_history where deal_id = v_deal) = 1,
    'creating a deal records where it started'
  );

  select * into v_row from deal_stage_history where deal_id = v_deal;
  perform test_assert(v_row.source = 'create', 'and says that is what happened');
  perform test_assert(v_row.from_stage_id is null, 'with no stage it came from, because there was none');
  perform test_assert(v_row.to_stage_id = v_quote, 'and the stage it started in');
  perform test_assert(v_row.changed_by = v_rep, 'and who did it');

  update deals set stage_id = v_proposal where id = v_deal;

  perform test_assert(
    (select count(*) from deal_stage_history where deal_id = v_deal) = 2,
    'moving the deal records the move'
  );

  select * into v_row from deal_stage_history
  where deal_id = v_deal order by changed_at desc, id desc limit 1;
  perform test_assert(v_row.from_stage_id = v_quote, 'from the stage it left');
  perform test_assert(v_row.to_stage_id = v_proposal, 'to the stage it reached');
  perform test_assert(v_row.source = 'move', 'and calls it a move');

  -- Editing anything else must not write history, or the table fills with
  -- rows that record nothing.
  update deals set value = 2000, name = 'Journey renamed' where id = v_deal;
  perform test_assert(
    (select count(*) from deal_stage_history where deal_id = v_deal) = 2,
    'editing a deal without moving it records nothing'
  );

  -- Going backwards is a real event and is recorded like any other.
  update deals set stage_id = v_quote where id = v_deal;
  perform test_assert(
    (select count(*) from deal_stage_history where deal_id = v_deal) = 3,
    'moving a deal backwards is recorded too'
  );

  update deals set stage_id = v_won where id = v_deal;
  perform test_assert(
    (select count(*) from deal_stage_history where deal_id = v_deal) = 4,
    'and so is the move that wins it'
  );
end;
$$;

-- =============================================================================
-- Nobody writes history by hand.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_deal  uuid := (select id from fixture where key = 'deal');
  v_quote uuid := (select id from fixture where key = 'quote');
  v_failed boolean;
begin
  raise notice 'The one door:';

  perform sign_in_as('mgr_auth');

  v_failed := false;
  begin
    insert into deal_stage_history (organization_id, deal_id, to_stage_id, source)
    values (v_org, v_deal, v_quote, 'move');
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'even a manager cannot invent a stage change');

  v_failed := false;
  begin
    update deal_stage_history set changed_at = now() - interval '1 year' where deal_id = v_deal;
  exception when others then
    v_failed := true;
  end;
  perform test_assert(
    v_failed or (select count(*) from deal_stage_history
                 where deal_id = v_deal and changed_at < now() - interval '1 day') = 0,
    'nor backdate one'
  );

  v_failed := false;
  begin
    delete from deal_stage_history where deal_id = v_deal;
  exception when others then
    v_failed := true;
  end;
  perform test_assert(
    v_failed or (select count(*) from deal_stage_history where deal_id = v_deal) = 4,
    'nor delete one — a history somebody can edit is not a history'
  );
end;
$$;

-- =============================================================================
-- History is as visible as the deal it belongs to.
-- =============================================================================
do $$
declare
  v_deal uuid := (select id from fixture where key = 'deal');
begin
  raise notice 'Who sees it:';

  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select count(*) from deal_stage_history where deal_id = v_deal) = 4,
    'a manager sees the whole path'
  );

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from deal_stage_history where deal_id = v_deal) = 4,
    'so does the owner'
  );

  perform sign_in_as('rep2_auth');
  perform test_assert(
    (select count(*) from deal_stage_history where deal_id = v_deal) = 0,
    'another rep sees none of it — history follows the deal'
  );
end;
$$;

-- =============================================================================
-- Time in stage, derived rather than stored.
-- =============================================================================
do $$
declare
  v_deal  uuid := (select id from fixture where key = 'deal');
  v_won   uuid := (select id from fixture where key = 'won');
  v_rows  int;
  v_open  int;
begin
  raise notice 'Time in stage:';

  perform sign_in_as('mgr_auth');

  select count(*) into v_rows from public.deal_stage_durations(v_deal);
  perform test_assert(v_rows = 4, 'one span per arrival');

  select count(*) into v_open from public.deal_stage_durations(v_deal) where is_current;
  perform test_assert(v_open = 1, 'exactly one of them is the stage it is in now');

  perform test_assert(
    (select stage_id from public.deal_stage_durations(v_deal) where is_current) = v_won,
    'and it is the stage the deal is actually in'
  );

  perform test_assert(
    (select bool_and(seconds_in >= 0) from public.deal_stage_durations(v_deal)),
    'no span runs backwards'
  );

  -- The clock stops when the deal closes. A deal won in March has not been
  -- sitting in Won ever since.
  perform test_assert(
    (select seconds_in from public.deal_stage_durations(v_deal) where is_current) < 60,
    'the current span of a closed deal is measured to its close, not to now'
  );
end;
$$;

-- =============================================================================
-- The funnel.
-- =============================================================================
do $$
declare
  v_org      uuid := (select id from fixture where key = 'org');
  v_quote    uuid := (select id from fixture where key = 'quote');
  v_proposal uuid := (select id from fixture where key = 'proposal');
  v_lost     uuid := (select id from fixture where key = 'lost');
  v_rep      uuid := (select id from fixture where key = 'rep');
  v_second   uuid;
  v_row      record;
begin
  raise notice 'The funnel:';

  perform sign_in_as('rep_auth');

  -- A second deal that stops at Proposal and is lost there.
  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Stalled', v_quote, 500, 'USD', v_rep) returning id into v_second;
  update deals set stage_id = v_proposal where id = v_second;
  update deals set stage_id = v_lost where id = v_second;

  perform sign_in_as('mgr_auth');

  select * into v_row from public.stage_funnel(null) where stage_id = v_quote;
  perform test_assert(v_row.reached = 2, 'both deals reached the first stage');

  select * into v_row from public.stage_funnel(null) where stage_id = v_proposal;
  perform test_assert(v_row.reached = 2, 'and both reached Proposal');
  perform test_assert(v_row.won_after = 1, 'one of them went on to be won');
  perform test_assert(v_row.lost_after = 1, 'and one was lost');

  -- The first deal went Quote → Proposal → Quote → Won. It reached Quote
  -- twice, and counting it twice would report more deals than exist.
  perform test_assert(
    (select reached from public.stage_funnel(null) where stage_id = v_quote) = 2,
    'a deal that comes back to a stage is still one deal that reached it'
  );

  select * into v_row from public.stage_funnel(null) where stage_id = v_lost;
  perform test_assert(v_row.still_there = 1, 'the lost deal is sitting in Lost');
  perform test_assert(v_row.reached = 1, 'and only it ever reached that stage');

  perform test_assert(
    (select median_days from public.stage_funnel(null) where stage_id = v_proposal) is not null,
    'and the funnel can say how long deals sat there'
  );
end;
$$;

-- =============================================================================
-- Backfilled rows are observations, not transitions.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_quote uuid := (select id from fixture where key = 'quote');
  v_rep   uuid := (select id from fixture where key = 'rep');
  v_old   uuid;
  v_before bigint;
begin
  raise notice 'Deals that predate the table:';

  perform sign_in_as('mgr_auth');
  select reached into v_before from public.stage_funnel(null) where stage_id = v_quote;

  -- Simulate a deal that existed before this migration: its trigger row is
  -- replaced by a backfill row, exactly as the migration wrote them.
  perform sign_in_as('rep_auth');
  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Ancient', v_quote, 100, 'USD', v_rep) returning id into v_old;

  set local role postgres;
  update deal_stage_history set source = 'backfill' where deal_id = v_old;
  set local role authenticated;

  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select reached from public.stage_funnel(null) where stage_id = v_quote) = v_before,
    'a backfilled row is not counted as having reached a stage — nobody saw it arrive'
  );

  perform test_assert(
    (select count(*) from public.deal_stage_durations(v_old)) = 1,
    'but it still has a span, so its time in stage is knowable'
  );
end;
$$;

-- =============================================================================
-- A deleted deal leaves the history behind it, as it leaves every report.
-- =============================================================================
do $$
declare
  v_deal uuid := (select id from fixture where key = 'deal');
begin
  raise notice 'Deleted deals:';

  perform sign_in_as('rep_auth');
  perform public.soft_delete_deal(v_deal);

  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select count(*) from public.deal_stage_durations(v_deal)) = 0,
    'a deleted deal is out of the durations'
  );
  perform test_assert(
    (select won_after from public.stage_funnel(null)
     where stage_id = (select id from fixture where key = 'proposal')) = 0,
    'and out of the funnel, so deleting a deal does not leave a ghost win behind'
  );
end;
$$;

rollback;
