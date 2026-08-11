-- =============================================================================
-- Pipeline order, and notes on a deal
--
-- Two unrelated columns, kept in one migration because they arrived together
-- and neither is worth a file of its own.
--
-- Pipelines were listed alphabetically, which is an accident of their names
-- rather than a decision about which desk matters most. They now carry their
-- own order, reordered the way stages are — by renumbering the whole set, so a
-- position asked for is the position taken.
--
-- Deals had nowhere to write down what the deal is actually about. The body of
-- a note is markdown, the same as the contact and company cards, so the
-- renderer already exists.
-- =============================================================================

do $$
begin
  if to_regprocedure('public.is_org_admin()') is null then
    raise exception 'Run the earlier migrations first — this one builds on is_org_admin().';
  end if;
end
$$;

alter table pipelines add column if not exists "order" integer not null default 0;
alter table deals     add column if not exists notes text;

comment on column pipelines."order" is
  'Position in the pipeline bar. Contiguous from 0; write it through reorder_pipeline().';
comment on column deals.notes is
  'Free-form markdown about the deal. Rendered with the same renderer as contact and company cards.';

-- Existing pipelines keep the order they were already being shown in, so
-- nothing jumps the first time somebody loads the board.
with ranked as (
  select id, row_number() over (partition by organization_id order by name, created_at, id) - 1 as position
  from pipelines
)
update pipelines
set "order" = ranked.position
from ranked
where pipelines.id = ranked.id
  and pipelines."order" is distinct from ranked.position;

/**
 * Places a pipeline at a position and renumbers the organization's set.
 *
 * The same shape as reorder_stage, and for the same reason: a number written
 * straight into the column is a request rather than a position, because
 * nothing stops two pipelines holding it. Clamped at both ends — a big number
 * means last, a negative one means first.
 */
create or replace function public.reorder_pipeline(p_pipeline_id uuid, p_position integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org    uuid := public.current_org_id();
  v_ids    uuid[];
  v_target integer;
  v_index  integer;
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can reorder pipelines';
  end if;

  if not exists (select 1 from public.pipelines where id = p_pipeline_id and organization_id = v_org) then
    raise exception 'Pipeline not found';
  end if;

  select coalesce(array_agg(id order by "order", created_at, id), '{}')
  into v_ids
  from public.pipelines
  where organization_id = v_org and id <> p_pipeline_id;

  v_target := least(greatest(coalesce(p_position, 0), 0), coalesce(array_length(v_ids, 1), 0));
  v_ids := v_ids[1:v_target] || p_pipeline_id || v_ids[v_target + 1:];

  for v_index in 1..array_length(v_ids, 1) loop
    update public.pipelines
    set "order" = v_index - 1
    where id = v_ids[v_index]
      and "order" is distinct from v_index - 1;
  end loop;
end
$$;

/** One place left or right, which is what an arrow in the settings list means. */
create or replace function public.move_pipeline(p_pipeline_id uuid, p_delta integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   uuid := public.current_org_id();
  v_ids   uuid[];
  v_index integer;
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can reorder pipelines';
  end if;

  select array_agg(id order by "order", created_at, id)
  into v_ids
  from public.pipelines
  where organization_id = v_org;

  v_index := array_position(v_ids, p_pipeline_id);
  if v_index is null then
    raise exception 'Pipeline not found';
  end if;

  perform public.reorder_pipeline(p_pipeline_id, (v_index - 1) + coalesce(p_delta, 0));
end
$$;

revoke execute on function public.reorder_pipeline(uuid, integer) from public;
revoke execute on function public.move_pipeline(uuid, integer) from public;
grant execute on function public.reorder_pipeline(uuid, integer) to authenticated, service_role;
grant execute on function public.move_pipeline(uuid, integer) to authenticated, service_role;
