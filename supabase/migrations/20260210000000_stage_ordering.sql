-- =============================================================================
-- Stage ordering
--
-- `order` was a number anybody could type, with nothing keeping it unique. Set
-- a stage to 2 while another stage already sat at 2 and the pipeline had two
-- second stages; Postgres then broke the tie however it liked, so a stage asked
-- to be second could appear third. The number was a request, not a position.
--
-- Ordering is now a rewrite of the whole pipeline rather than an edit of one
-- row. Placing a stage renumbers every stage in it to 0, 1, 2 … in one
-- statement-run inside one function, so positions are always contiguous, always
-- unique, and always mean what they say.
--
-- Deliberately not a unique constraint on (pipeline_id, "order"): renumbering
-- walks the list one update at a time and any intermediate state would violate
-- it. The functions below are the only supported way to write the column, and
-- they leave it consistent every time.
-- =============================================================================

do $$
begin
  if to_regprocedure('public.is_org_admin()') is null then
    raise exception 'Run the earlier migrations first — this one builds on is_org_admin().';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Repair what the old behaviour left behind.
--
-- Existing pipelines may already hold duplicates or gaps. Renumber every one of
-- them, keeping the order they currently appear in so nothing visibly moves.
-- -----------------------------------------------------------------------------
with ranked as (
  select
    id,
    row_number() over (partition by pipeline_id order by "order", created_at, id) - 1 as position
  from stages
)
update stages
set "order" = ranked.position
from ranked
where stages.id = ranked.id
  and stages."order" is distinct from ranked.position;

/**
 * Places a stage at a position and renumbers its pipeline.
 *
 * `p_position` is 0-based and clamped: asking for 99 in a five-stage pipeline
 * means "last" rather than an error, because that is what somebody typing a big
 * number into the order box means.
 *
 * The sort that decides everyone else's relative order is
 * ("order", created_at, id) — fully deterministic even when the stored orders
 * are still duplicated, which they may be the first time this runs.
 */
create or replace function public.reorder_stage(p_stage_id uuid, p_position integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org      uuid := public.current_org_id();
  v_pipeline uuid;
  v_ids      uuid[];
  v_target   integer;
  v_index    integer;
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can reorder stages';
  end if;

  select pipeline_id into v_pipeline
  from public.stages
  where id = p_stage_id and organization_id = v_org;

  if v_pipeline is null then
    raise exception 'Stage not found';
  end if;

  select coalesce(array_agg(id order by "order", created_at, id), '{}')
  into v_ids
  from public.stages
  where pipeline_id = v_pipeline
    and organization_id = v_org
    and id <> p_stage_id;

  v_target := least(greatest(coalesce(p_position, 0), 0), coalesce(array_length(v_ids, 1), 0));

  -- Put it back in at the requested place, then number the result.
  v_ids := v_ids[1:v_target] || p_stage_id || v_ids[v_target + 1:];

  for v_index in 1..array_length(v_ids, 1) loop
    update public.stages
    set "order" = v_index - 1
    where id = v_ids[v_index]
      and "order" is distinct from v_index - 1;
  end loop;
end
$$;

/**
 * Moves a stage one place up or down.
 *
 * The relative version, because that is what a person clicking an arrow means.
 * Computing the neighbour here rather than in the application keeps the read
 * and the write in one transaction — two administrators reordering at once
 * cannot interleave into a mess.
 */
create or replace function public.move_stage(p_stage_id uuid, p_delta integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org      uuid := public.current_org_id();
  v_pipeline uuid;
  v_ids      uuid[];
  v_index    integer;
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can reorder stages';
  end if;

  select pipeline_id into v_pipeline
  from public.stages
  where id = p_stage_id and organization_id = v_org;

  if v_pipeline is null then
    raise exception 'Stage not found';
  end if;

  select array_agg(id order by "order", created_at, id)
  into v_ids
  from public.stages
  where pipeline_id = v_pipeline and organization_id = v_org;

  v_index := array_position(v_ids, p_stage_id);

  -- array_position is 1-based; reorder_stage takes a 0-based position.
  perform public.reorder_stage(p_stage_id, (v_index - 1) + coalesce(p_delta, 0));
end
$$;

revoke execute on function public.reorder_stage(uuid, integer) from public;
revoke execute on function public.move_stage(uuid, integer) from public;
grant execute on function public.reorder_stage(uuid, integer) to authenticated, service_role;
grant execute on function public.move_stage(uuid, integer) to authenticated, service_role;
