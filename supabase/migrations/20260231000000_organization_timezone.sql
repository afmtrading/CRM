-- =============================================================================
-- The organization's timezone
--
-- THE PROBLEM
--
-- A deal is created at 8pm on 13 August in Toronto. Stored as a timestamptz
-- that is 03:00 on 14 August UTC. Every screen that turned that instant into a
-- calendar day did it in UTC, so the ledger said the deal was initiated on the
-- 14th — and the date filter agreed with the ledger, so the two were consistent
-- with each other and wrong about the same thing. A month's figures ran from
-- 8pm on the last day of the previous month.
--
-- THE DECISION
--
-- One timezone per organization, not per viewer. A report is a statement about
-- the business, and two people in different cities reading the same report must
-- see the same number — which rules out the browser's zone, however friendly
-- that would feel on a single record.
--
-- WHERE THE CONVERSION HAPPENS
--
-- Here, once. deal_ledger now returns created_day and closed_day: real dates,
-- already in the organization's zone. Everything downstream — the column, the
-- filter, the sort, the CSV, the month buckets on the charts — reads a plain
-- YYYY-MM-DD and needs to know nothing about timezones at all. Doing it in
-- TypeScript instead would have meant every consumer converting separately, and
-- the first one to forget would put the report back where it started.
--
-- created_at is still there, still an instant. It is the right thing for "when
-- exactly did this happen"; it is the wrong thing to slice the first ten
-- characters off, and now nothing does.
-- =============================================================================

alter table organizations
  add column if not exists timezone text not null default 'America/Toronto';

comment on column organizations.timezone is
  'IANA zone. The one clock this organization''s reports are read against — not the viewer''s.';

/**
 * Refuses a zone Postgres does not know.
 *
 * A check constraint cannot do this: the list of zones lives in a view, and a
 * check may not read a table. A trigger runs on the two statements a year that
 * touch this column, so the cost is nothing and the guarantee is the same —
 * an unknown zone would make every date on every report silently wrong.
 */
create or replace function public.organizations_validate_timezone()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone: %', new.timezone;
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_timezone on organizations;
create trigger organizations_timezone
  before insert or update of timezone on organizations
  for each row execute function public.organizations_validate_timezone();

-- -----------------------------------------------------------------------------
-- The ledger, in the organization's own days
--
-- Dropped and recreated rather than replaced: create or replace cannot add
-- columns to a function's result, which is the whole point of this change.
-- -----------------------------------------------------------------------------

drop function if exists public.deal_ledger(text);

create function public.deal_ledger(p_region_key text default null)
returns table (
  deal_id           uuid,
  name              text,
  status            deal_status,
  pipeline_id       uuid,
  pipeline_name     text,
  stage_id          uuid,
  stage_name        text,
  stage_order       integer,
  owner_id          uuid,
  owner_name        text,
  closed_owner_id   uuid,
  closed_owner_name text,
  company_id        uuid,
  company_name      text,
  contact_id        uuid,
  contact_name      text,
  value             numeric,
  currency          text,
  probability       numeric,
  weighted_value    numeric,
  revenue           numeric,
  cost              numeric,
  margin            numeric,
  line_count        integer,
  costed_lines      integer,
  created_at        timestamptz,
  /** created_at as a calendar day in the organization's zone. */
  created_day       date,
  expected_close_date date,
  actual_close_date date,
  closed_at         timestamptz,
  /** closed_at as a calendar day in the organization's zone. */
  closed_day        date,
  loss_reason       text,
  cycle_days        integer,
  products          text[],
  regions           text[]
)
language sql
stable
set search_path = public, pg_temp
as $$
  with tz as (
    -- One lookup, reused for every row. The organization is already decided by
    -- the RLS predicate below, so this cannot read another tenant's setting.
    select coalesce(
      (select o.timezone from organizations o where o.id = public.current_org_id()),
      'UTC'
    ) as zone
  ),
  lines as (
    select
      dp.deal_id,
      sum(dp.line_total)                                as revenue,
      sum(dp.line_cost)                                 as cost,
      count(*)::int                                     as line_count,
      count(*) filter (where dp.line_cost > 0)::int     as costed_lines,
      array_agg(distinct p.name) filter (where p.name is not null) as products
    from deal_products dp
    join products p on p.id = dp.product_id
    group by dp.deal_id
  )
  select
    d.id,
    d.name,
    d.status,
    s.pipeline_id,
    pl.name,
    d.stage_id,
    s.name,
    s."order",
    d.owner_id,
    coalesce(o.name, o.email),
    d.closed_owner_id,
    coalesce(co.name, co.email),
    d.company_id,
    c.name,
    d.contact_id,
    nullif(trim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')), ''),
    d.value,
    d.currency,
    d.probability,
    round(d.value * d.probability, 2),

    lines.revenue,
    lines.cost,
    case when lines.line_count is null then null else lines.revenue - lines.cost end,
    coalesce(lines.line_count, 0),
    coalesce(lines.costed_lines, 0),

    d.created_at,
    (d.created_at at time zone tz.zone)::date,
    d.expected_close_date,
    d.actual_close_date,
    d.closed_at,
    (d.closed_at at time zone tz.zone)::date,
    d.loss_reason,

    -- Counted between two days in the same zone. Mixing a user-entered close
    -- date with a UTC-derived creation day used to make a deal opened late on a
    -- Monday and closed on the Tuesday look like it took no time at all.
    case
      when d.status in ('won', 'lost')
      then (
        coalesce(d.actual_close_date, (d.closed_at at time zone tz.zone)::date)
          - (d.created_at at time zone tz.zone)::date
      )::int
    end,

    coalesce(lines.products, array[]::text[]),

    case
      when p_region_key is null then array[]::text[]
      when jsonb_typeof(c.custom_fields -> p_region_key) = 'array'
        then array(select jsonb_array_elements_text(c.custom_fields -> p_region_key))
      when nullif(c.custom_fields ->> p_region_key, '') is not null
        then array[c.custom_fields ->> p_region_key]
      else array[]::text[]
    end

  from deals d
  cross join tz
  join stages s      on s.id = d.stage_id
  join pipelines pl  on pl.id = s.pipeline_id
  left join users o  on o.id = d.owner_id
  left join users co on co.id = d.closed_owner_id
  left join companies c on c.id = d.company_id
  left join contacts ct on ct.id = d.contact_id
  left join lines on lines.deal_id = d.id
  where d.organization_id = public.current_org_id()
    and d.deleted_at is null;
$$;

comment on function public.deal_ledger(text) is
  'Every visible deal on one row, with days resolved in the organization''s timezone. Invoker: the deals policy decides who sees what.';

revoke execute on function public.deal_ledger(text) from public, anon;
grant execute on function public.deal_ledger(text) to authenticated, service_role;
