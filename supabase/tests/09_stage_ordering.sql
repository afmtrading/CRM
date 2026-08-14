-- =============================================================================
-- Stage ordering.
--
--   A position asked for is the position taken. `order` used to be a number
--   anybody could type with nothing keeping it unique, so setting a stage to 2
--   while another already sat at 2 produced two second stages and Postgres
--   chose between them however it liked.
--
--   Placing a stage now renumbers its whole pipeline, so positions are always
--   0, 1, 2 … with no gaps and no duplicates. These tests hold that line, and
--   check that reordering stays an administrator's job and stays inside one
--   organization.
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

/** The pipeline's stage names, in the order they would appear on the board. */
create or replace function stage_names(p_pipeline uuid)
returns text[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select array_agg(name order by "order", created_at, id)
  from stages
  where pipeline_id = p_pipeline;
$$;

grant execute on function stage_names(uuid) to authenticated;

/** The positions themselves, to prove they are contiguous and unique. */
create or replace function stage_positions(p_pipeline uuid)
returns integer[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select array_agg("order" order by "order", created_at, id)
  from stages
  where pipeline_id = p_pipeline;
$$;

grant execute on function stage_positions(uuid) to authenticated;

do $$
declare
  v_org       uuid;
  v_other     uuid;
  v_admin_a   uuid := gen_random_uuid();
  v_rep_a     uuid := gen_random_uuid();
  v_badmin_a  uuid := gen_random_uuid();
  v_admin     uuid;
  v_rep       uuid;
  v_badmin    uuid;
  v_pipeline  uuid;
  v_bpipeline uuid;
  v_new       uuid;
  v_quoted    uuid;
  v_won       uuid;
  v_bstage    uuid;
begin
  insert into organizations (name, slug) values ('Stage Co', 'stage-co') returning id into v_org;
  insert into organizations (name, slug) values ('Other Stage Co', 'other-stage-co') returning id into v_other;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@stage.test'),
    (v_rep_a, 'rep@stage.test'),
    (v_badmin_a, 'admin@otherstage.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@stage.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@stage.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'admin@otherstage.test', 'Bo', 'admin', v_badmin_a, 'active') returning id into v_badmin;

  insert into pipelines (organization_id, name, is_default)
  values (v_org, 'Trading', false) returning id into v_pipeline;
  insert into pipelines (organization_id, name, is_default)
  values (v_other, 'Theirs', false) returning id into v_bpipeline;

  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_pipeline, 'New', 0, 0.1) returning id into v_new;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_pipeline, 'Quoted', 1, 0.5) returning id into v_quoted;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_pipeline, 'Won', 2, 1) returning id into v_won;

  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_other, v_bpipeline, 'Theirs', 0, 0.5) returning id into v_bstage;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_admin_a), ('rep_auth', v_rep_a), ('badmin_auth', v_badmin_a),
    ('pipeline', v_pipeline), ('bpipeline', v_bpipeline),
    ('new', v_new), ('quoted', v_quoted), ('won', v_won), ('bstage', v_bstage);
end;
$$;

set local role authenticated;

-- =============================================================================
-- A position asked for is the position taken.
-- =============================================================================
do $$
declare
  v_pipeline uuid := (select id from fixture where key = 'pipeline');
begin
  raise notice 'Placing a stage:';
  perform sign_in_as('admin_auth');

  perform test_assert(
    stage_names(v_pipeline) = array['New', 'Quoted', 'Won'],
    'the pipeline starts in the order it was built'
  );

  -- The reported bug: Won asked to be second and landed third, because Quoted
  -- was already holding 1 and nothing renumbered.
  perform reorder_stage((select id from fixture where key = 'won'), 1);

  perform test_assert(
    stage_names(v_pipeline) = array['New', 'Won', 'Quoted'],
    'a stage sent to position 1 is second, and the stage it displaced moves down'
  );

  perform test_assert(
    stage_positions(v_pipeline) = array[0, 1, 2],
    'and the positions are renumbered contiguously, with no duplicates left behind'
  );
end;
$$;

-- =============================================================================
-- The ends of the list behave.
-- =============================================================================
do $$
declare
  v_pipeline uuid := (select id from fixture where key = 'pipeline');
begin
  raise notice 'Edges:';
  perform sign_in_as('admin_auth');

  -- Somebody typing a big number into the box means "put it last".
  perform reorder_stage((select id from fixture where key = 'new'), 99);
  perform test_assert(
    stage_names(v_pipeline) = array['Won', 'Quoted', 'New'],
    'a position past the end means last, rather than an error'
  );

  perform reorder_stage((select id from fixture where key = 'new'), -5);
  perform test_assert(
    stage_names(v_pipeline) = array['New', 'Won', 'Quoted'],
    'and a negative one means first'
  );

  perform test_assert(
    stage_positions(v_pipeline) = array[0, 1, 2],
    'the positions stay contiguous through both'
  );
end;
$$;

-- =============================================================================
-- Moving one place at a time.
-- =============================================================================
do $$
declare
  v_pipeline uuid := (select id from fixture where key = 'pipeline');
begin
  raise notice 'Moving up and down:';
  perform sign_in_as('admin_auth');

  perform move_stage((select id from fixture where key = 'quoted'), -1);
  perform test_assert(
    stage_names(v_pipeline) = array['New', 'Quoted', 'Won'],
    'moving a stage up swaps it with the one above'
  );

  perform move_stage((select id from fixture where key = 'new'), 1);
  perform test_assert(
    stage_names(v_pipeline) = array['Quoted', 'New', 'Won'],
    'and moving one down swaps it with the one below'
  );

  -- The interface disables these, but the function should not depend on that.
  perform move_stage((select id from fixture where key = 'quoted'), -1);
  perform test_assert(
    stage_names(v_pipeline) = array['Quoted', 'New', 'Won'],
    'moving the first stage up does nothing, rather than falling off the list'
  );

  perform move_stage((select id from fixture where key = 'won'), 1);
  perform test_assert(
    stage_names(v_pipeline) = array['Quoted', 'New', 'Won'],
    'and moving the last one down does nothing either'
  );
end;
$$;

-- =============================================================================
-- Who may reorder, and whose stages they may reach.
-- =============================================================================
do $$
declare
  v_failed   boolean := false;
  v_pipeline uuid := (select id from fixture where key = 'pipeline');
begin
  raise notice 'Permission:';

  perform sign_in_as('rep_auth');
  begin
    perform reorder_stage((select id from fixture where key = 'won'), 0);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'a rep cannot reorder stages');

  v_failed := false;
  perform sign_in_as('rep_auth');
  begin
    perform move_stage((select id from fixture where key = 'won'), -1);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'nor move one');

  perform sign_in_as('admin_auth');
  perform test_assert(
    stage_names(v_pipeline) = array['Quoted', 'New', 'Won'],
    'and nothing they tried actually moved'
  );

  -- The function runs as definer, so the organization check inside it is the
  -- only thing standing between two tenants.
  v_failed := false;
  perform sign_in_as('badmin_auth');
  begin
    perform reorder_stage((select id from fixture where key = 'won'), 0);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(
    v_failed,
    'an administrator of another organization cannot reach these stages at all'
  );
end;
$$;

-- =============================================================================
-- One pipeline's ordering is its own.
-- =============================================================================
do $$
declare
  v_pipeline  uuid := (select id from fixture where key = 'pipeline');
  v_bpipeline uuid := (select id from fixture where key = 'bpipeline');
begin
  raise notice 'Isolation:';
  perform sign_in_as('admin_auth');

  perform reorder_stage((select id from fixture where key = 'won'), 0);

  perform test_assert(
    stage_names(v_bpipeline) = array['Theirs'],
    'renumbering one pipeline leaves another organization''s untouched'
  );
  perform test_assert(
    stage_positions(v_pipeline) = array[0, 1, 2],
    'and the reordered pipeline is still contiguous'
  );
end;
$$;

-- =============================================================================
-- What a stage means is settable, and is what closes a deal.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_stage uuid;
  v_deal  uuid;
begin
  raise notice 'Stage outcome:';

  perform sign_in_as('admin_auth');

  -- A seeded pipeline knows what its own stages mean. This is the regression
  -- that mattered: the migration adding the column backfilled existing stages
  -- and left the seed alone, so every organization created afterwards got a
  -- Won stage that closed nothing.
  perform test_assert(
    (select s.outcome from stages s join pipelines p on p.id = s.pipeline_id
     where p.organization_id = v_org and p.name = 'Sales Pipeline' and s.name = 'Won') = 'won',
    'a seeded Won stage closes deals as won'
  );
  perform test_assert(
    (select s.outcome from stages s join pipelines p on p.id = s.pipeline_id
     where p.organization_id = v_org and p.name = 'Sales Pipeline' and s.name = 'Lost') = 'lost',
    'and a seeded Lost stage closes them as lost'
  );
  perform test_assert(
    (select s.outcome from stages s join pipelines p on p.id = s.pipeline_id
     where p.organization_id = v_org and p.name = 'Sales Pipeline' and s.name = 'New') = 'open',
    'while the rest leave them open'
  );

  -- An administrator can say what a renamed stage means, which is what the
  -- Settings screen now writes.
  select s.id into v_stage from stages s join pipelines p on p.id = s.pipeline_id
  where p.organization_id = v_org and p.name = 'Sales Pipeline' and s.name = 'Negotiation';

  update stages set name = 'Closed — Won', outcome = 'won' where id = v_stage;

  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Lands in the renamed stage', v_stage, 500, 'USD',
          (select id from fixture where key = 'admin'))
  returning id into v_deal;

  perform test_assert(
    (select status from deals where id = v_deal) = 'won',
    'a deal landing in a stage marked won is won, whatever the stage is called'
  );
  perform test_assert(
    (select closed_at is not null from deals where id = v_deal),
    'and it is stamped closed'
  );
end;
$$;

rollback;
