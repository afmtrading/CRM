-- =============================================================================
-- The deal ledger
--
-- Every deal ever recorded, on one row each, with the things a sales director
-- asks about already joined: who owns it, what it is for, which company and
-- therefore which region, what it is worth and what it actually made.
--
-- WHY A FUNCTION AND NOT A VIEW
--
-- A view would be the same query, and PostgREST would let the client join its
-- way to most of this. The reason to name it once, here, is that four of these
-- columns are *derived* and each has a rule that must not be re-invented by the
-- next caller:
--
--   weighted_value  value x probability. A forecast.
--   margin          revenue minus cost, and NULL — not zero — when the deal has
--                   no line items to derive either from.
--   products        the distinct catalogue items on the deal.
--   regions         the company's own region list, whatever an admin has
--                   called that field.
--
-- WHY INVOKER AND NOT DEFINER
--
-- Deliberately not SECURITY DEFINER, unlike the stock functions. Those answer a
-- question about the warehouse, which is nobody's private business. This one
-- answers "which deals", and the row-level policy on deals is exactly the right
-- answer: an administrator or manager sees the organization, everybody else
-- sees their own. Reporting must not become a way around that.
-- =============================================================================

create or replace function public.deal_ledger(p_region_key text default null)
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
  expected_close_date date,
  actual_close_date date,
  closed_at         timestamptz,
  loss_reason       text,
  cycle_days        integer,
  products          text[],
  regions           text[]
)
language sql
stable
set search_path = public, pg_temp
as $$
  with lines as (
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

    -- Revenue and cost come off the line items or not at all. A deal priced by
    -- hand has no cost anywhere, so its margin is unknown; reporting zero would
    -- read as "we made full margin", which is the opposite of the truth.
    lines.revenue,
    lines.cost,
    case when lines.line_count is null then null else lines.revenue - lines.cost end,
    coalesce(lines.line_count, 0),
    coalesce(lines.costed_lines, 0),

    d.created_at,
    d.expected_close_date,
    d.actual_close_date,
    d.closed_at,
    d.loss_reason,

    -- How long the deal took, counted only once it has actually closed. Uses
    -- the close date the user can correct rather than the system stamp, since
    -- that is the date they mean when they say a deal closed in March.
    case
      when d.status in ('won', 'lost')
      then (coalesce(d.actual_close_date, d.closed_at::date) - d.created_at::date)::int
    end,

    coalesce(lines.products, array[]::text[]),

    -- Region is an organization-defined field on the company, so its key is
    -- passed in rather than written here: an admin may have called it anything,
    -- and a hardcoded 'regions' would silently return nothing the day it is
    -- renamed. Multiselect stores an array, select stores a string; both are
    -- read, because either is a reasonable way to have set the field up.
    case
      when p_region_key is null then array[]::text[]
      when jsonb_typeof(c.custom_fields -> p_region_key) = 'array'
        then array(select jsonb_array_elements_text(c.custom_fields -> p_region_key))
      when nullif(c.custom_fields ->> p_region_key, '') is not null
        then array[c.custom_fields ->> p_region_key]
      else array[]::text[]
    end

  from deals d
  join stages s      on s.id = d.stage_id
  join pipelines pl  on pl.id = s.pipeline_id
  left join users o  on o.id = d.owner_id
  left join users co on co.id = d.closed_owner_id
  left join companies c on c.id = d.company_id
  left join contacts ct on ct.id = d.contact_id
  left join lines on lines.deal_id = d.id
  where d.organization_id = public.current_org_id()
    -- Deleted deals are in the recycle bin, and the bin is not a report. An
    -- administrator can still see them on the deal itself; they do not belong
    -- in a total.
    and d.deleted_at is null;
$$;

comment on function public.deal_ledger(text) is
  'Every visible deal on one row, with owner, company, region, products and derived value. Invoker: the deals policy decides who sees what.';

revoke execute on function public.deal_ledger(text) from public, anon;
grant execute on function public.deal_ledger(text) to authenticated, service_role;
