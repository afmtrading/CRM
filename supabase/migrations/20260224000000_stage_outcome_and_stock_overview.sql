-- =============================================================================
-- A stage that says "Won" should mean the deal is won
--
-- Two notions of winning have coexisted since the beginning and never spoke to
-- each other: a stage called "Won" — seeded into every new pipeline — and a
-- `status` column holding 'open', 'won' or 'lost'. Dragging a deal into the Won
-- stage moved stage_id and nothing else, so the deal stayed open as far as
-- every query was concerned.
--
-- Reported as "committed stock does not drop when I mark a deal won", which is
-- the symptom the stock summary surfaced. But the same gap was already there in
-- the pipeline report, the status filter on the deal list, and the close date
-- that is supposed to be stamped when a deal closes. Stock is only where it
-- became visible.
--
-- WHY A COLUMN AND NOT A NAME
--
-- Matching on the word "Won" would work today and break the first time somebody
-- renames a stage to "Closed — Won", writes it in French, or adds a second
-- winning stage. So a stage now carries what it means, the seeded ones are
-- given the obvious values, and existing stages are matched by name once, here,
-- where the guess is visible and can be corrected in Settings.
-- =============================================================================

alter table stages
  add column if not exists outcome text not null default 'open';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stages_outcome_check') then
    alter table stages add constraint stages_outcome_check
      check (outcome in ('open', 'won', 'lost'));
  end if;
end
$$;

comment on column stages.outcome is
  'What reaching this stage means for the deal. Moving a deal here sets its status to match.';

-- The one-time guess. Deliberately narrow: an exact name, not a pattern, so
-- "Won back" or "Lost interest" are not swept up by it.
update stages
set outcome = case
  when lower(trim(name)) in ('won', 'closed won', 'closed — won', 'closed - won') then 'won'
  when lower(trim(name)) in ('lost', 'closed lost', 'closed — lost', 'closed - lost') then 'lost'
  else 'open'
end
where outcome = 'open';

-- -----------------------------------------------------------------------------
-- Moving a deal decides its status
--
-- Only when the stage actually changes. A deal whose status is set by hand on
-- the form — without touching the stage — keeps what was chosen, so the status
-- field does not become a control that silently disagrees with itself.
--
-- Named to sort before deals_apply_stage_probability, which stamps the close
-- date from the status: this has to have set the status by the time that runs,
-- or a deal dragged into Won would close without a close date.
-- -----------------------------------------------------------------------------
create or replace function public.deals_apply_stage_outcome()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_outcome text;
begin
  if tg_op = 'INSERT' then
    select outcome into v_outcome from public.stages where id = new.stage_id;

    -- Only a closing stage speaks on insert. There is no previous stage to have
    -- moved out of, so an 'open' stage says nothing — and overriding on it
    -- would throw away a status the caller set deliberately, which is exactly
    -- what an import of already-won deals does.
    if v_outcome in ('won', 'lost') then
      new.status := v_outcome::deal_status;
    end if;

  elsif new.stage_id is distinct from old.stage_id then
    select outcome into v_outcome from public.stages where id = new.stage_id;

    -- On a move the stage is the intent, including a move back: dragging a card
    -- out of Won into a working stage plainly reopens the deal.
    if v_outcome is not null then
      new.status := v_outcome::deal_status;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists deals_apply_stage_outcome on deals;
create trigger deals_apply_stage_outcome
  before insert or update of stage_id on deals
  for each row execute function public.deals_apply_stage_outcome();

-- Deals already sitting in a Won or Lost stage were never told. Bringing them
-- into line is the point of the whole migration — without this the committed
-- figures stay wrong for every deal that closed before today.
update deals d
set status = s.outcome::deal_status
from stages s
where s.id = d.stage_id
  and s.outcome <> 'open'
  and d.status::text <> s.outcome;

-- =============================================================================
-- Stock for a whole catalogue at once
--
-- product_stock_summary answers for one product, which is right for a record
-- page and hopeless for a list: five hundred products would be five hundred
-- round trips. This is the same four numbers for every product in the
-- organization, in one query, plus where the stock is.
--
-- Definer for the same reason the single-product version is: committed comes
-- off deal_products, which is visible only for deals the caller owns, so an
-- invoker function would quietly under-report to a sales rep.
-- =============================================================================
create or replace function public.product_stock_overview()
returns table (
  product_id uuid,
  on_hand    numeric,
  committed  numeric,
  reserved   numeric,
  available  numeric,
  locations  text[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with placed as (
    select
      l.product_id,
      sum(l.quantity) as on_hand,
      sum(l.reserved) as reserved,
      -- The short code where there is one: a list column has room for "TOR",
      -- not for "Toronto Distribution Centre".
      array_agg(distinct coalesce(nullif(trim(loc.code), ''), loc.name))
        filter (where l.quantity > 0) as locations
    from stock_levels l
    join stock_locations loc on loc.id = l.location_id
    where l.organization_id = public.current_org_id()
    group by l.product_id
  ),
  promised as (
    select dp.product_id, sum(dp.quantity) as committed
    from deal_products dp
    join deals d on d.id = dp.deal_id
    where dp.organization_id = public.current_org_id()
      and d.status = 'open'
    group by dp.product_id
  )
  select
    p.id,
    coalesce(placed.on_hand, 0),
    coalesce(promised.committed, 0),
    coalesce(placed.reserved, 0),
    -- Negative when more is promised than exists, as everywhere else.
    coalesce(placed.on_hand, 0) - coalesce(promised.committed, 0) - coalesce(placed.reserved, 0),
    coalesce(placed.locations, array[]::text[])
  from products p
  left join placed on placed.product_id = p.id
  left join promised on promised.product_id = p.id
  where p.organization_id = public.current_org_id()
    and p.deleted_at is null;
$$;

revoke execute on function public.product_stock_overview() from public, anon;
grant execute on function public.product_stock_overview() to authenticated, service_role;
