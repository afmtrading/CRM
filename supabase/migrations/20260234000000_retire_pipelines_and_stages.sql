-- =============================================================================
-- Retiring a pipeline, or a stage
--
-- THE BUG
--
-- Settings → Pipelines → Delete threw a raw Postgres foreign key error, which
-- Next.js turns into "Application error: a server-side exception has occurred"
-- and a digest. Nothing reached the person pressing the button.
--
-- Underneath it was worse than a missing message. `deals.stage_id` is
-- `on delete restrict`, so the app caught the violation and said:
--
--     This pipeline still has deals in it. Move them first.
--
-- Move them, press Delete again, and it fails a second time — because
-- `deal_stage_history.to_stage_id` is `on delete restrict` too, and history is
-- append-only. Every deal that has ever passed through a stage leaves a row
-- pointing at it forever. So the advice was a dead end: a pipeline that has
-- ever been used could not be deleted, by any sequence of actions available in
-- the app, and the only message on offer told you to keep trying.
--
-- WHY NOT JUST CASCADE THE HISTORY
--
-- Because that history is the answer to "how long do deals sit in Negotiation"
-- and "what did this deal do before it closed", and it feeds deal_ledger.
-- Deleting an organization's stage-timing record to tidy a list of pipelines is
-- a bad trade made silently. Tidying is not a reason to lose an audit trail.
--
-- WHAT HAPPENS INSTEAD
--
-- Delete when there is nothing to lose, archive when there is:
--
--   never used at all   deleted outright, row and all. The typo case — a
--                       pipeline made by mistake this morning — stays instant.
--   used before now     archived. It leaves the board, the pipeline bar and
--                       every picker, keeps its history, and can be restored.
--                       Deals won or lost in it stay exactly where they are.
--   open deals in it    refused, with the count. This is the one case where
--                       "move them first" is true, and now it is also enough:
--                       once they are moved, the next press archives.
--
-- Only open deals block it. A won or lost deal belongs to the pipeline it was
-- won or lost in, and telling somebody to move their closed deals out of the
-- way is telling them to falsify their own record to satisfy a constraint.
--
-- Archiving a pipeline archives its stages at the same instant, so a stage in a
-- retired pipeline cannot turn up in a picker. Restoring brings back exactly
-- the stages that went with it — matched on that shared timestamp — so a stage
-- retired separately, earlier, stays retired.
--
-- THE DELETED DEAL THAT COMES BACK
--
-- A deal in the recycle bin does not block archiving; it is not on the board
-- and nobody is waiting for it. But restoring one would drop it into a stage
-- that no longer appears anywhere — a deal that exists, counts towards stock
-- and pipeline value, and cannot be seen. So restore_deal now unarchives the
-- stage and pipeline it lands in. Putting a deal back is a decision that it
-- belongs on the board again, and the column it belongs in has to come with it.
-- =============================================================================

alter table public.pipelines add column if not exists archived_at timestamptz;
alter table public.stages    add column if not exists archived_at timestamptz;

comment on column public.pipelines.archived_at is
  'Retired: hidden from the board and every picker, history intact. Null means live.';
comment on column public.stages.archived_at is
  'Retired: hidden from the board and every picker, history intact. Null means live.';

-- -----------------------------------------------------------------------------
-- What is in a pipeline
--
-- So Settings can say "3 deals" beside the name rather than let somebody find
-- out by pressing Delete. Invoker, not definer: the counts are only ever read
-- on the admin-only pipelines page, and an administrator's own view of deals is
-- already the whole organization's, including the recycle bin.
-- -----------------------------------------------------------------------------
create or replace function public.pipeline_usage()
returns table (
  pipeline_id uuid,
  /** Open deals — the ones on the board. These are what block retiring it. */
  open_deals  bigint,
  /** Won and lost. These are the reason it archives instead of deleting. */
  closed      bigint,
  /** In the recycle bin. These block nothing, but they can come back. */
  binned      bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    s.pipeline_id,
    -- count(d.id), not count(*): the join is a left one so that a pipeline with
    -- no deals still gets a row, and count(*) would score each of its empty
    -- stages as a deal.
    count(d.id) filter (where d.deleted_at is null and d.status = 'open'),
    count(d.id) filter (where d.deleted_at is null and d.status <> 'open'),
    count(d.id) filter (where d.deleted_at is not null)
  from public.stages s
  left join public.deals d on d.stage_id = s.id
  where s.organization_id = (select public.current_org_id())
  group by s.pipeline_id;
$$;

comment on function public.pipeline_usage() is
  'Deals per pipeline, on the board and in the bin, so Settings can say so before you press Delete.';

-- -----------------------------------------------------------------------------
-- Retiring a pipeline
--
-- Returns what it did, because the two outcomes are genuinely different and the
-- person pressing the button deserves to be told which one they got.
--
-- The choice between them is not made by counting rows and then deciding. It is
-- made by attempting the delete and letting the foreign keys answer: anything
-- still pointing at this pipeline's stages, of any kind, present or future,
-- turns the delete into an archive. A count could be wrong, or go stale, or
-- miss a table added next year. The constraint cannot.
-- -----------------------------------------------------------------------------
create or replace function public.remove_pipeline(p_pipeline_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_name    text;
  v_default boolean;
  v_live    bigint;
  v_others  bigint;
  -- clock_timestamp, not now(): now() is the transaction's start time and is
  -- identical for every call inside one transaction, so a stage retired on its
  -- own moments earlier would share the pipeline's stamp and be restored with
  -- it. The stamp is how restore tells those two apart, so it has to move.
  v_now     timestamptz := clock_timestamp();
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can retire a pipeline';
  end if;

  select name, is_default into v_name, v_default
  from public.pipelines
  where id = p_pipeline_id and organization_id = v_org and archived_at is null;

  if v_name is null then
    raise exception 'Pipeline not found';
  end if;

  -- Open deals only. A won or lost deal belongs to the pipeline it was won or
  -- lost in, permanently, and asking somebody to move their closed deals
  -- somewhere else to tidy a list would be asking them to falsify the record.
  -- Those deals are a reason to archive rather than delete, not a blocker.
  select count(*) into v_live
  from public.deals d
  join public.stages s on s.id = d.stage_id
  where s.pipeline_id = p_pipeline_id and d.deleted_at is null and d.status = 'open';

  if v_live > 0 then
    raise exception 'This pipeline still has % open deal(s) on the board. Move them to another pipeline first.', v_live;
  end if;

  select count(*) into v_others
  from public.pipelines
  where organization_id = v_org and archived_at is null and id <> p_pipeline_id;

  if v_others = 0 then
    raise exception 'This is the only pipeline left. There would be nowhere to put a deal.';
  end if;

  if v_default then
    raise exception 'This is the default pipeline. Make another one the default first.';
  end if;

  begin
    -- Stages go with it: the cascade is on stages.pipeline_id.
    delete from public.pipelines where id = p_pipeline_id;
    return 'deleted';
  exception when foreign_key_violation then
    -- Something in the record still points at a stage of this pipeline — the
    -- stage history of a deal that has since moved on, or a deal in the bin.
    -- Neither is a reason to lose it, and neither is a reason to keep showing
    -- the pipeline. The delete above is rolled back to this block's savepoint;
    -- the rows are all still there.
    null;
  end;

  -- One timestamp shared by the pipeline and its stages, so restore can tell
  -- the stages that went down with it from ones retired on their own earlier.
  update public.stages
  set archived_at = v_now
  where pipeline_id = p_pipeline_id and archived_at is null;

  update public.pipelines
  set archived_at = v_now
  where id = p_pipeline_id;

  return 'archived';
end;
$$;

comment on function public.remove_pipeline(uuid) is
  'Deletes a pipeline nothing refers to, archives one something does. Returns which.';

create or replace function public.restore_pipeline(p_pipeline_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_archived timestamptz;
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can restore a pipeline';
  end if;

  select archived_at into v_archived
  from public.pipelines
  where id = p_pipeline_id and organization_id = public.current_org_id();

  if v_archived is null then
    raise exception 'Pipeline not found, or not archived';
  end if;

  -- Only the stages retired by this pipeline's own archiving. A stage somebody
  -- retired separately, at some other moment, stays retired — restoring the
  -- pipeline was not a decision about it.
  update public.stages
  set archived_at = null
  where pipeline_id = p_pipeline_id and archived_at = v_archived;

  update public.pipelines set archived_at = null where id = p_pipeline_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Retiring a stage
--
-- The same rule, one level down. "Delete stage" had the identical dead end: the
-- history rows outlive the deals, so a stage anything had ever entered refused
-- to go and said "Move them to another stage first" forever.
-- -----------------------------------------------------------------------------
create or replace function public.remove_stage(p_stage_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org      uuid := public.current_org_id();
  v_pipeline uuid;
  v_live     bigint;
  v_siblings bigint;
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can retire a stage';
  end if;

  select pipeline_id into v_pipeline
  from public.stages
  where id = p_stage_id and organization_id = v_org and archived_at is null;

  if v_pipeline is null then
    raise exception 'Stage not found';
  end if;

  -- Open ones only, for the same reason as a pipeline: a deal closed in this
  -- stage stays in it.
  select count(*) into v_live
  from public.deals
  where stage_id = p_stage_id and deleted_at is null and status = 'open';

  if v_live > 0 then
    raise exception 'This stage still holds % open deal(s). Move them to another stage first.', v_live;
  end if;

  select count(*) into v_siblings
  from public.stages
  where pipeline_id = v_pipeline and archived_at is null and id <> p_stage_id;

  if v_siblings = 0 then
    raise exception 'A pipeline needs at least one stage. Add another before retiring this one.';
  end if;

  begin
    delete from public.stages where id = p_stage_id;
    return 'deleted';
  exception when foreign_key_violation then
    null;
  end;

  update public.stages set archived_at = clock_timestamp() where id = p_stage_id;
  return 'archived';
end;
$$;

comment on function public.remove_stage(uuid) is
  'Deletes a stage nothing refers to, archives one something does. Returns which.';

create or replace function public.restore_stage(p_stage_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can restore a stage';
  end if;

  -- Its pipeline comes back with it. A stage restored into a pipeline nobody
  -- can see is not restored.
  update public.pipelines p
  set archived_at = null
  from public.stages s
  where s.id = p_stage_id
    and s.organization_id = public.current_org_id()
    and p.id = s.pipeline_id;

  update public.stages
  set archived_at = null
  where id = p_stage_id and organization_id = public.current_org_id();
end;
$$;

-- -----------------------------------------------------------------------------
-- A deal coming back out of the bin brings its column with it
--
-- Otherwise restoring one puts a live deal into a stage that no picker offers
-- and no board draws: it counts towards pipeline value and holds stock, and
-- nobody can find it. Unchanged in every other respect.
-- -----------------------------------------------------------------------------
create or replace function public.restore_deal(p_deal_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org    uuid := public.current_org_id();
  v_stage  uuid;
  v_status deal_status;
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can restore a record';
  end if;

  update public.deals
  set deleted_at = null, deleted_by = null
  where id = p_deal_id and organization_id = v_org
  returning stage_id, status into v_stage, v_status;

  -- Only an open deal needs a column to sit in. A won or lost one restored into
  -- an archived pipeline reads fine on its own page and in every report, and
  -- dragging a retired pipeline back onto the board for it would be a surprise.
  if v_stage is null or v_status <> 'open' then
    return;
  end if;

  update public.pipelines p
  set archived_at = null
  from public.stages s
  where s.id = v_stage and p.id = s.pipeline_id and p.archived_at is not null;

  update public.stages
  set archived_at = null
  where id = v_stage and archived_at is not null;
end;
$$;

revoke execute on function public.pipeline_usage() from public, anon;
revoke execute on function public.remove_pipeline(uuid) from public, anon;
revoke execute on function public.restore_pipeline(uuid) from public, anon;
revoke execute on function public.remove_stage(uuid) from public, anon;
revoke execute on function public.restore_stage(uuid) from public, anon;
revoke execute on function public.restore_deal(uuid) from public, anon;

grant execute on function public.pipeline_usage() to authenticated, service_role;
grant execute on function public.remove_pipeline(uuid) to authenticated, service_role;
grant execute on function public.restore_pipeline(uuid) to authenticated, service_role;
grant execute on function public.remove_stage(uuid) to authenticated, service_role;
grant execute on function public.restore_stage(uuid) to authenticated, service_role;
grant execute on function public.restore_deal(uuid) to authenticated, service_role;
