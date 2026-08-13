-- =============================================================================
-- Where a deal has been, not just where it is
--
-- A deal carries one stage_id: its current one. That is enough to draw a board
-- and nothing else. It cannot answer "which stage do we lose deals at", "how
-- long do they sit in Proposal", or "which deals have gone backwards" — the
-- three questions a pipeline is actually managed on.
--
-- This is the same asymmetry that made soft delete urgent in Phase 0: a report
-- can be built at any time from data already captured, but a stage move that
-- happened yesterday and was not recorded is gone for good. Every day without
-- this is a day of pipeline history that cannot be reconstructed.
--
-- WHAT IS AND IS NOT STORED
--
-- The move is stored: which stage to, which stage from, when, and by whom.
-- How *long* the deal sat in the previous stage is NOT stored — it is the
-- difference between two rows that are already here, and storing it would be a
-- second copy of a fact, free to drift from the first. Same reasoning as
-- committed stock, which is read off open deals rather than kept in a column.
-- =============================================================================

create table if not exists deal_stage_history (
  id              uuid primary key default gen_random_uuid(),
  /**
   * The order events actually happened in.
   *
   * changed_at alone is not enough. Two moves inside one transaction get the
   * same timestamp — now() is the transaction's start time, not the clock — and
   * ordering by a random uuid to break the tie puts a deal's path in an
   * arbitrary sequence. Dragging a card twice in quick succession is enough to
   * do it. This is the total order; changed_at is what it happened at.
   */
  seq             bigint generated always as identity,
  organization_id uuid not null references organizations (id) on delete cascade,
  deal_id         uuid not null references deals (id) on delete cascade,
  /** Null when the deal was created — there is no stage it came from. */
  from_stage_id   uuid references stages (id) on delete set null,
  to_stage_id     uuid not null references stages (id) on delete restrict,
  changed_by      uuid references users (id) on delete set null,
  -- clock_timestamp, not now(): an audit row wants the moment it was written,
  -- and now() would stamp every row in a transaction with the same instant.
  changed_at      timestamptz not null default clock_timestamp(),
  /**
   * How this row came to exist.
   *
   * 'create' and 'move' are observed facts, written by the trigger at the
   * moment they happened. 'backfill' is not: it is one row per deal that
   * already existed when this migration ran, asserting only "this deal was in
   * this stage at this point", because the path it took to get there was never
   * recorded and cannot be invented. Anything measuring a funnel has to be able
   * to tell the two apart, so it is a column rather than a comment.
   */
  source          text not null default 'move'
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deal_stage_history_source_check') then
    alter table deal_stage_history add constraint deal_stage_history_source_check
      check (source in ('create', 'move', 'backfill'));
  end if;
end
$$;

-- The two questions asked of this table: one deal's path, and every move into
-- or out of a stage.
create index if not exists deal_stage_history_deal_idx
  on deal_stage_history (deal_id, changed_at, seq);
create index if not exists deal_stage_history_stage_idx
  on deal_stage_history (organization_id, to_stage_id, changed_at desc);

revoke all on deal_stage_history from anon;
-- Select only. Nobody writes history by hand: see the trigger below.
grant select on deal_stage_history to authenticated;

alter table deal_stage_history enable row level security;
alter table deal_stage_history force row level security;

-- History follows the deal it belongs to, stated through `exists` so it cannot
-- drift from the deals policy — the same shape deal_products uses.
drop policy if exists deal_stage_history_select on deal_stage_history;
create policy deal_stage_history_select on deal_stage_history
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and exists (select 1 from deals d where d.id = deal_stage_history.deal_id)
  );

-- No insert, update or delete policy, deliberately. A history somebody can
-- edit is not a history. The trigger below is definer and is the only way a row
-- gets here — the same "one door" the stock ledger is built on.

/**
 * Records every arrival in a stage.
 *
 * AFTER rather than BEFORE: the deal row has to exist before a row can point a
 * foreign key at it, which matters on INSERT.
 *
 * Definer because the table grants no INSERT to anybody. That is the point —
 * it makes the trigger the only writer, so the record cannot be edited around
 * afterwards.
 */
create or replace function public.deals_record_stage_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.deal_stage_history
      (organization_id, deal_id, from_stage_id, to_stage_id, changed_by, source)
    values
      (new.organization_id, new.id, null, new.stage_id, public.current_app_user_id(), 'create');

  elsif new.stage_id is distinct from old.stage_id then
    insert into public.deal_stage_history
      (organization_id, deal_id, from_stage_id, to_stage_id, changed_by, source)
    values
      (new.organization_id, new.id, old.stage_id, new.stage_id, public.current_app_user_id(), 'move');
  end if;

  return null;
end;
$$;

drop trigger if exists deals_record_stage_change on deals;
create trigger deals_record_stage_change
  after insert or update of stage_id on deals
  for each row execute function public.deals_record_stage_change();

revoke execute on function public.deals_record_stage_change() from public, anon;

-- -----------------------------------------------------------------------------
-- One row for every deal that already existed
--
-- Marked 'backfill', and dated to the deal's creation. It says the deal is in
-- this stage; it does not claim the deal entered this stage then, because
-- nobody knows. Reporting is expected to exclude these from anything that
-- measures a transition, which is why they are labelled rather than blended in.
-- -----------------------------------------------------------------------------
insert into deal_stage_history
  (organization_id, deal_id, from_stage_id, to_stage_id, changed_by, changed_at, source)
select d.organization_id, d.id, null, d.stage_id, null, d.created_at, 'backfill'
from deals d
where not exists (
  select 1 from deal_stage_history h where h.deal_id = d.id
);

-- =============================================================================
-- Time in stage, and where deals actually go
--
-- Both derived from the rows above rather than stored beside them.
--
-- Invoker, like deal_ledger and for the same reason: this answers "which
-- deals", and the policy on deals is already the right answer to that.
-- =============================================================================

/**
 * Every stage a deal has been in, with how long it stayed.
 *
 * The duration of the last row is measured to now for an open deal and to its
 * close for a closed one — a deal that closed in March has not been sitting in
 * Won for five months.
 */
create or replace function public.deal_stage_durations(p_deal_id uuid default null)
returns table (
  deal_id       uuid,
  stage_id      uuid,
  stage_name    text,
  entered_at    timestamptz,
  left_at       timestamptz,
  seconds_in    numeric,
  is_current    boolean,
  source        text
)
language sql
stable
set search_path = public, pg_temp
as $$
  with moves as (
    select
      h.deal_id,
      h.to_stage_id,
      h.changed_at,
      h.seq,
      h.source,
      lead(h.changed_at) over (partition by h.deal_id order by h.changed_at, h.seq) as next_at
    from deal_stage_history h
    where h.organization_id = public.current_org_id()
      and (p_deal_id is null or h.deal_id = p_deal_id)
  )
  select
    m.deal_id,
    m.to_stage_id,
    s.name,
    m.changed_at,
    m.next_at,
    extract(epoch from (
      /*
       * greatest(..., m.changed_at) so a span can never run backwards.
       *
       * Two ways it otherwise could. actual_close_date is a date the user may
       * edit, and nothing stops them dating a close before the deal reached the
       * stage it closed in. And closed_at is stamped with now() — the
       * transaction's start — while these rows carry clock_timestamp(), so the
       * close can read a few milliseconds earlier than the move that caused it.
       * Either way the honest answer is that no measurable time was spent, not
       * a negative duration.
       */
      greatest(
        coalesce(
          m.next_at,
          -- Still the current stage: run the clock to the close, or to now.
          case
            when d.status in ('won', 'lost')
            then coalesce(d.closed_at, d.actual_close_date::timestamptz, now())
            else now()
          end
        ),
        m.changed_at
      ) - m.changed_at
    )),
    m.next_at is null,
    m.source
  from moves m
  join deals d on d.id = m.deal_id
  left join stages s on s.id = m.to_stage_id
  where d.deleted_at is null
  order by m.deal_id, m.changed_at, m.seq;
$$;

/**
 * How many deals reached each stage, and what became of them.
 *
 * This is the funnel the charts could not draw before. Counts distinct deals
 * that ever *arrived* in a stage, which is a different and more useful number
 * than how many are sitting there now.
 *
 * Deals whose only history row is a backfill are excluded from `reached`: they
 * were observed in a stage, never seen to enter one, and counting them would
 * put every pre-existing deal at whatever stage it happens to be in today.
 */
create or replace function public.stage_funnel(p_pipeline_id uuid default null)
returns table (
  stage_id     uuid,
  stage_name   text,
  stage_order  integer,
  pipeline_id  uuid,
  reached      bigint,
  still_there  bigint,
  won_after    bigint,
  lost_after   bigint,
  median_days  numeric
)
language sql
stable
set search_path = public, pg_temp
as $$
  with arrivals as (
    select distinct on (h.deal_id, h.to_stage_id)
      h.deal_id,
      h.to_stage_id,
      h.changed_at
    from deal_stage_history h
    join deals d on d.id = h.deal_id
    where h.organization_id = public.current_org_id()
      and h.source in ('create', 'move')
      and d.deleted_at is null
    order by h.deal_id, h.to_stage_id, h.changed_at, h.seq
  ),
  durations as (
    select deal_id, stage_id, seconds_in
    from public.deal_stage_durations()
    where source in ('create', 'move')
  )
  select
    s.id,
    s.name,
    s."order",
    s.pipeline_id,
    count(distinct a.deal_id),
    count(distinct a.deal_id) filter (where d.stage_id = s.id),
    count(distinct a.deal_id) filter (where d.status = 'won'),
    count(distinct a.deal_id) filter (where d.status = 'lost'),
    percentile_cont(0.5) within group (
      order by (select dur.seconds_in from durations dur
                where dur.deal_id = a.deal_id and dur.stage_id = s.id
                limit 1) / 86400.0
    )
  from stages s
  left join arrivals a on a.to_stage_id = s.id
  left join deals d on d.id = a.deal_id
  where s.organization_id = public.current_org_id()
    and (p_pipeline_id is null or s.pipeline_id = p_pipeline_id)
  group by s.id, s.name, s."order", s.pipeline_id
  order by s."order";
$$;

revoke execute on function public.deal_stage_durations(uuid) from public, anon;
revoke execute on function public.stage_funnel(uuid) from public, anon;
grant execute on function public.deal_stage_durations(uuid) to authenticated, service_role;
grant execute on function public.stage_funnel(uuid) to authenticated, service_role;
