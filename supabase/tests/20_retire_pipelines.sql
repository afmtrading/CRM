-- =============================================================================
-- Retiring pipelines and stages.
--
--   Delete used to throw a raw foreign key error at anything that had ever
--   held a deal, and the advice it gave — move the deals out and try again —
--   did not work, because deal_stage_history keeps pointing at the stage long
--   after the deal has left it.
--
--   These tests pin down the three outcomes: deleted when nothing refers to
--   it, archived when something does, refused while deals are still on the
--   board. Plus the guards (last pipeline, default pipeline, last stage), who
--   may do it, and the deal that comes back out of the recycle bin into a
--   stage that was archived behind it.
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

/** Whether a pipeline is still on the board. */
create or replace function pipeline_live(p_key text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select archived_at is null from pipelines where id = (select id from fixture where key = p_key);
$$;

grant execute on function pipeline_live(text) to authenticated;

/** Whether a pipeline row still exists at all. */
create or replace function pipeline_exists(p_key text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from pipelines where id = (select id from fixture where key = p_key));
$$;

grant execute on function pipeline_exists(text) to authenticated;

create or replace function stage_live(p_key text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select archived_at is null from stages where id = (select id from fixture where key = p_key);
$$;

grant execute on function stage_live(text) to authenticated;

create or replace function stage_exists(p_key text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from stages where id = (select id from fixture where key = p_key));
$$;

grant execute on function stage_exists(text) to authenticated;

-- -----------------------------------------------------------------------------
-- The organization
--
--   default    the seeded Sales Pipeline. Stays put; it is the default.
--   used       has held a deal, which we move away. Should archive.
--   fresh      created and never touched. Should delete outright.
--   binned     holds one soft-deleted deal and nothing else. Should archive,
--              and come back when the deal is restored.
-- -----------------------------------------------------------------------------
do $$
declare
  v_org     uuid;
  v_other   uuid;
  v_aa      uuid := gen_random_uuid();
  v_ra      uuid := gen_random_uuid();
  v_ba      uuid := gen_random_uuid();
  v_admin   uuid;
  v_rep     uuid;
  v_badmin  uuid;
  v_used    uuid;
  v_fresh   uuid;
  v_binned  uuid;
  v_theirs  uuid;
  v_us1     uuid;
  v_us2     uuid;
  v_bs      uuid;
  v_home    uuid;
  v_deal    uuid;
  v_bdeal   uuid;
begin
  insert into organizations (name, slug) values ('Retire Co', 'retire-co') returning id into v_org;
  insert into organizations (name, slug) values ('Their Co', 'their-co') returning id into v_other;

  insert into auth.users (id, email) values
    (v_aa, 'admin@retire.test'), (v_ra, 'rep@retire.test'), (v_ba, 'admin@their.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@retire.test', 'Ada', 'admin', v_aa, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@retire.test', 'Raj', 'regular', v_ra, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'admin@their.test', 'Bo', 'admin', v_ba, 'active') returning id into v_badmin;

  -- Somewhere for the deals to be moved to: the seeded pipeline's first stage.
  select s.id into v_home
  from stages s join pipelines p on p.id = s.pipeline_id
  where p.organization_id = v_org and p.is_default
  order by s."order" limit 1;

  insert into pipelines (organization_id, name, is_default, "order")
  values (v_org, 'Used', false, 1) returning id into v_used;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_used, 'U1', 0, 0.5) returning id into v_us1;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_used, 'U2', 1, 0.5) returning id into v_us2;

  insert into pipelines (organization_id, name, is_default, "order")
  values (v_org, 'Fresh', false, 2) returning id into v_fresh;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_fresh, 'F1', 0, 0.5);

  insert into pipelines (organization_id, name, is_default, "order")
  values (v_org, 'Binned', false, 3) returning id into v_binned;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_binned, 'B1', 0, 0.5) returning id into v_bs;

  insert into pipelines (organization_id, name, is_default, "order")
  values (v_other, 'Theirs', false, 0) returning id into v_theirs;

  insert into deals (organization_id, name, stage_id, owner_id, value, currency)
  values (v_org, 'A deal', v_us1, v_admin, 100, 'USD') returning id into v_deal;

  insert into deals (organization_id, name, stage_id, owner_id, value, currency)
  values (v_org, 'A binned deal', v_bs, v_admin, 50, 'USD') returning id into v_bdeal;
  update deals set deleted_at = now(), deleted_by = v_admin where id = v_bdeal;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_aa), ('rep_auth', v_ra), ('badmin_auth', v_ba),
    ('used', v_used), ('fresh', v_fresh), ('binned', v_binned), ('theirs', v_theirs),
    ('us1', v_us1), ('us2', v_us2), ('bs', v_bs), ('home', v_home),
    ('deal', v_deal), ('bdeal', v_bdeal);
end;
$$;

set local role authenticated;

-- =============================================================================
-- A pipeline with deals on the board is refused, and says how many.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('admin_auth');

  begin
    perform public.remove_pipeline((select id from fixture where key = 'used'));
    perform test_assert(false, 'a pipeline holding a deal is refused');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%1 open deal(s) on the board%',
    'the refusal counts the deals rather than quoting a constraint name');
  perform test_assert(pipeline_live('used'), 'and the pipeline is untouched');
end;
$$;

-- =============================================================================
-- Move the deal out, and it archives rather than failing a second time.
--
-- This is the bug. deal_stage_history still points at U1, so the delete cannot
-- succeed — and before this migration the app said "move them first" again, to
-- somebody who just had.
-- =============================================================================
do $$
declare v_result text;
begin
  perform sign_in_as('admin_auth');

  update deals set stage_id = (select id from fixture where key = 'home')
  where id = (select id from fixture where key = 'deal');

  perform test_assert(
    exists (
      select 1 from deal_stage_history
      where to_stage_id = (select id from fixture where key = 'us1')
    ),
    'the stage history outlives the deal that left');

  v_result := public.remove_pipeline((select id from fixture where key = 'used'));

  perform test_assert(v_result = 'archived', 'a pipeline with history behind it archives');
  perform test_assert(pipeline_exists('used'), 'the row survives');
  perform test_assert(not pipeline_live('used'), 'and leaves the board');
  perform test_assert(not stage_live('us1'), 'its stages go with it');
  perform test_assert(not stage_live('us2'), 'both of them');
end;
$$;

-- =============================================================================
-- Restoring brings back exactly what went down with it.
-- =============================================================================
do $$
begin
  perform sign_in_as('admin_auth');

  -- U1 is the stage the deal passed through, so it has history and archives.
  -- Retired here on its own, at its own instant, before the pipeline is.
  perform public.restore_pipeline((select id from fixture where key = 'used'));
  perform test_assert(public.remove_stage((select id from fixture where key = 'us1')) = 'archived',
    'a stage with history behind it archives too');
  perform test_assert(not stage_live('us1'), 'and leaves the board');

  perform public.remove_pipeline((select id from fixture where key = 'used'));
  perform public.restore_pipeline((select id from fixture where key = 'used'));

  perform test_assert(pipeline_live('used'), 'the pipeline comes back');
  perform test_assert(stage_live('us2'), 'with the stage that went down with it');
  perform test_assert(not stage_live('us1'),
    'but not one retired separately beforehand — that was a different decision');
end;
$$;

-- =============================================================================
-- A pipeline nothing has ever referred to is deleted outright.
-- =============================================================================
do $$
declare v_result text;
begin
  perform sign_in_as('admin_auth');

  v_result := public.remove_pipeline((select id from fixture where key = 'fresh'));

  perform test_assert(v_result = 'deleted', 'an unused pipeline is deleted, not archived');
  perform test_assert(not pipeline_exists('fresh'), 'and the row is gone');
end;
$$;

-- =============================================================================
-- The last pipeline, and the default one, are refused.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('admin_auth');

  -- Off the default pipeline, so it is the default that is refused rather than
  -- the deal sitting on it. The two checks are separate, and this one is about
  -- the default.
  update deals set stage_id = (select id from fixture where key = 'us2')
  where id = (select id from fixture where key = 'deal');

  begin
    perform public.remove_pipeline(
      (select id from pipelines where organization_id = (select id from fixture where key = 'org')
       and is_default));
    perform test_assert(false, 'the default pipeline is refused');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%default pipeline%',
    'and says to make another one the default first');
end;
$$;

do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_message text;
  v_last    uuid;
begin
  perform sign_in_as('admin_auth');

  -- Nothing on the board anywhere, so that what refuses the last pipeline is
  -- the count of pipelines rather than the count of deals. That guard is
  -- checked before the default one, so the survivor being the default does not
  -- get in the way.
  update deals set deleted_at = now() where organization_id = v_org and deleted_at is null;

  perform public.remove_pipeline((select id from fixture where key = 'used'));
  perform public.remove_pipeline((select id from fixture where key = 'binned'));

  select id into v_last from pipelines where organization_id = v_org and archived_at is null;

  begin
    perform public.remove_pipeline(v_last);
    perform test_assert(false, 'the last pipeline standing is refused');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%only pipeline left%',
    'and says there would be nowhere to put a deal');

  -- Put the others back for the tests below, and the deal with them. Set
  -- directly rather than through restore_deal, whose unarchiving is what the
  -- recycle-bin test further down is about.
  perform public.restore_pipeline((select id from fixture where key = 'used'));
  perform public.restore_pipeline((select id from fixture where key = 'binned'));
  update deals set deleted_at = null where id = (select id from fixture where key = 'deal');
end;
$$;

-- =============================================================================
-- A pipeline needs at least one stage.
-- =============================================================================
do $$
declare
  v_message text;
  v_only    uuid;
begin
  perform sign_in_as('admin_auth');

  select id into v_only from stages
  where pipeline_id = (select id from fixture where key = 'binned') and archived_at is null;

  begin
    perform public.remove_stage(v_only);
    perform test_assert(false, 'the only stage in a pipeline is refused');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%at least one stage%',
    'and says to add another one first');
end;
$$;

-- =============================================================================
-- A deal coming out of the bin brings its column back with it.
--
-- The binned pipeline archives happily — a deleted deal is not on the board and
-- nobody is waiting for it. But restoring the deal without restoring the stage
-- would leave a live deal in a column no picker offers and no board draws.
-- =============================================================================
do $$
begin
  perform sign_in_as('admin_auth');

  perform test_assert(
    public.remove_pipeline((select id from fixture where key = 'binned')) = 'archived',
    'a pipeline whose only deal is in the bin archives');
  perform test_assert(not pipeline_live('binned'), 'and leaves the board');

  perform public.restore_deal((select id from fixture where key = 'bdeal'));

  perform test_assert(stage_live('bs'), 'restoring the deal brings its stage back');
  perform test_assert(pipeline_live('binned'), 'and the pipeline the stage is in');
  perform test_assert(
    (select deleted_at is null from deals where id = (select id from fixture where key = 'bdeal')),
    'and the deal itself is out of the bin, as it always was');
end;
$$;

-- =============================================================================
-- Who may retire one.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('rep_auth');

  begin
    perform public.remove_pipeline((select id from fixture where key = 'used'));
    perform test_assert(false, 'a sales rep may not retire a pipeline');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%administrator%', 'and is told why');
  perform test_assert(pipeline_live('used'), 'and nothing moved');
end;
$$;

do $$
declare v_message text;
begin
  perform sign_in_as('rep_auth');

  begin
    perform public.remove_stage((select id from fixture where key = 'us1'));
    perform test_assert(false, 'nor a stage');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%administrator%', 'and is told why');
end;
$$;

-- =============================================================================
-- One organization cannot retire another's pipeline.
--
-- The functions are SECURITY DEFINER, so row-level security is not what stops
-- this — the organization check inside them is. Which is exactly why it is
-- worth a test.
-- =============================================================================
do $$
declare v_message text;
begin
  perform sign_in_as('badmin_auth');

  begin
    perform public.remove_pipeline((select id from fixture where key = 'used'));
    perform test_assert(false, 'another org''s admin cannot reach this pipeline');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%not found%', 'it simply does not exist to them');
  perform test_assert(pipeline_live('used'), 'and it is still there');
end;
$$;

do $$
declare v_message text;
begin
  perform sign_in_as('badmin_auth');

  begin
    perform public.restore_pipeline((select id from fixture where key = 'used'));
    perform test_assert(false, 'nor restore it');
  exception when others then
    v_message := sqlerrm;
  end;

  perform test_assert(v_message like '%not found%', 'same answer, same reason');
end;
$$;

-- =============================================================================
-- What Settings reads to say "3 deals" before anybody presses Delete.
-- =============================================================================
do $$
declare
  v_open   bigint;
  v_closed bigint;
  v_binned bigint;
begin
  perform sign_in_as('admin_auth');

  -- Put a deal back on the used pipeline so there is something to count.
  update deals set stage_id = (select id from fixture where key = 'us2')
  where id = (select id from fixture where key = 'deal');

  select u.open_deals, u.closed, u.binned into v_open, v_closed, v_binned
  from public.pipeline_usage() u
  where u.pipeline_id = (select id from fixture where key = 'used');

  perform test_assert(v_open = 1, 'usage counts the deals on the board');
  perform test_assert(v_closed = 0, 'the closed ones separately');
  perform test_assert(v_binned = 0, 'and the bin separately again');
end;
$$;

do $$
declare v_rows bigint;
begin
  perform sign_in_as('badmin_auth');

  select count(*) into v_rows
  from public.pipeline_usage() u
  where u.pipeline_id = (select id from fixture where key = 'used');

  perform test_assert(v_rows = 0, 'and another organization sees none of it');
end;
$$;

-- =============================================================================
-- A won deal does not block retiring the pipeline it was won in.
--
-- It could not: the deal belongs to that pipeline permanently, and "move your
-- closed deals somewhere else" is an instruction to falsify the record. Closed
-- deals are the reason a pipeline archives rather than deletes, not a reason it
-- cannot go at all.
-- =============================================================================
do $$
declare
  v_open   bigint;
  v_closed bigint;
begin
  perform sign_in_as('admin_auth');

  update deals set status = 'won', stage_id = (select id from fixture where key = 'us2')
  where id = (select id from fixture where key = 'deal');

  select u.open_deals, u.closed into v_open, v_closed
  from public.pipeline_usage() u
  where u.pipeline_id = (select id from fixture where key = 'used');

  perform test_assert(v_open = 0 and v_closed = 1, 'a won deal counts as closed, not open');
  perform test_assert(
    public.remove_pipeline((select id from fixture where key = 'used')) = 'archived',
    'and the pipeline archives rather than refusing');
  perform test_assert(
    (select stage_id from deals where id = (select id from fixture where key = 'deal'))
      = (select id from fixture where key = 'us2'),
    'with the won deal still recorded in the stage it was won in');
end;
$$;

rollback;
