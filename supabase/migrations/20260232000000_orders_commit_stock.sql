-- =============================================================================
-- A signed sales order holds its stock
--
-- WHY THIS IS NOT A WRITE TO stock_levels.reserved
--
-- "Reserve stock when an order is signed" sounds like it should increment the
-- reserved column. It should not, and the stock migration already says why in
-- as many words:
--
--   Committed  what open deals have already promised. Not stored — it is read
--              off the deal line items, because a second copy of a number the
--              deals already know would start disagreeing with them the first
--              time anybody edited a deal.
--   Reserved   held back by hand, for a reason that is not a deal yet.
--
-- A sales order is not a reason that is not a deal yet. It is a document that
-- promises stock, which is exactly what `committed` already means — so a signed
-- order joins open deals in feeding it, derived, and reserved goes on meaning
-- what it has always meant: somebody put a pallet aside by hand.
--
-- Storing it instead would have needed a release path on every edge: cancel the
-- order, delete a line, change a quantity, delete the order, restore it from
-- the bin, convert it to an invoice. Every one of those is a chance to leak a
-- hold that nothing owns any more, and the leak is invisible — stock that
-- exists but that the app believes is spoken for. Derived needs none of them.
-- Cancel an order and it stops counting, because the count is a question rather
-- than a copy.
--
-- WHICH ORDERS COUNT
--
--   draft      no. It commits to nothing; that is what the status means.
--   reserved   yes. Signed, or a deposit taken. This is the ask.
--   confirmed  yes. Committed and ready to invoice.
--   fulfilled  no. The goods have gone. Counting them would hold stock that is
--              no longer in the building, and it matches what a won deal does:
--              it stops committing, and somebody records the movement against
--              on-hand. This CRM has never decremented stock by itself and does
--              not start here — that is the warehouse's job, and two systems
--              moving the same number is the bug this whole file avoids.
--   cancelled  no.
--
-- WHAT THE NUMBER NOW SAYS
--
-- committed is still on-hand's counterpart in `available`, unchanged in
-- meaning. It is now split into committed_deals and committed_orders as well,
-- because a number that grew for reasons the reader cannot see is a number they
-- stop trusting — and "which orders are holding this?" is the next question
-- anybody asks.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Which sales orders hold stock
--
-- One definition, used by both functions below, so the two can never disagree
-- about what a signed order is.
-- -----------------------------------------------------------------------------
create or replace function public.sales_order_holds_stock(p_status sales_order_status)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select p_status in ('reserved', 'confirmed');
$$;

comment on function public.sales_order_holds_stock(sales_order_status) is
  'Whether an order at this status has promised stock it has not yet handed over.';

-- -----------------------------------------------------------------------------
-- One product
--
-- Dropped and recreated: create or replace cannot add columns to a function''s
-- result, and the split is the point.
-- -----------------------------------------------------------------------------

drop function if exists public.product_stock_summary(uuid);

create function public.product_stock_summary(p_product_id uuid)
returns table (
  on_hand           numeric,
  committed         numeric,
  /** The part of committed that open deals are holding. */
  committed_deals   numeric,
  /** The part signed sales orders are holding. */
  committed_orders  numeric,
  reserved          numeric,
  available         numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org        uuid := public.current_org_id();
  v_on_hand    numeric;
  v_reserved   numeric;
  v_deals      numeric;
  v_orders     numeric;
begin
  if not exists (
    select 1 from products
    where id = p_product_id and (v_org is null or organization_id = v_org)
  ) then
    raise exception 'Product not found';
  end if;

  select coalesce(sum(l.quantity), 0), coalesce(sum(l.reserved), 0)
  into v_on_hand, v_reserved
  from stock_levels l
  where l.product_id = p_product_id;

  select coalesce(sum(dp.quantity), 0)
  into v_deals
  from deal_products dp
  join deals d on d.id = dp.deal_id
  where dp.product_id = p_product_id
    and d.status = 'open'
    -- A deleted deal has stopped promising anything.
    and d.deleted_at is null;

  select coalesce(sum(sl.quantity), 0)
  into v_orders
  from sales_order_lines sl
  join sales_orders o on o.id = sl.sales_order_id
  where sl.product_id = p_product_id
    and public.sales_order_holds_stock(o.status)
    -- And neither has a deleted order. The recycle bin is not a warehouse.
    and o.deleted_at is null;

  return query select
    v_on_hand,
    v_deals + v_orders,
    v_deals,
    v_orders,
    v_reserved,
    -- Deliberately not greatest(0, …): a negative available number means more
    -- has been promised than exists, which is the single most useful thing this
    -- function can tell anybody.
    v_on_hand - v_deals - v_orders - v_reserved;
end;
$$;

revoke execute on function public.product_stock_summary(uuid) from public, anon;
grant execute on function public.product_stock_summary(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The whole catalogue
-- -----------------------------------------------------------------------------

drop function if exists public.product_stock_overview();

create function public.product_stock_overview()
returns table (
  product_id       uuid,
  on_hand          numeric,
  committed        numeric,
  committed_deals  numeric,
  committed_orders numeric,
  reserved         numeric,
  available        numeric,
  locations        text[]
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
      and d.deleted_at is null
    group by dp.product_id
  ),
  ordered as (
    select sl.product_id, sum(sl.quantity) as committed
    from sales_order_lines sl
    join sales_orders o on o.id = sl.sales_order_id
    where sl.organization_id = public.current_org_id()
      and public.sales_order_holds_stock(o.status)
      and o.deleted_at is null
    group by sl.product_id
  )
  select
    p.id,
    coalesce(placed.on_hand, 0),
    coalesce(promised.committed, 0) + coalesce(ordered.committed, 0),
    coalesce(promised.committed, 0),
    coalesce(ordered.committed, 0),
    coalesce(placed.reserved, 0),
    -- Negative when more is promised than exists, as everywhere else.
    coalesce(placed.on_hand, 0)
      - coalesce(promised.committed, 0)
      - coalesce(ordered.committed, 0)
      - coalesce(placed.reserved, 0),
    coalesce(placed.locations, array[]::text[])
  from products p
  left join placed on placed.product_id = p.id
  left join promised on promised.product_id = p.id
  left join ordered on ordered.product_id = p.id
  where p.organization_id = public.current_org_id()
    and p.deleted_at is null;
$$;

revoke execute on function public.product_stock_overview() from public, anon;
grant execute on function public.product_stock_overview() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Which orders are holding a product
--
-- The question the split number provokes. Invoker rather than definer, unlike
-- the two above: those answer "how many", which is a fact about the warehouse
-- and nobody's private business, while this one names orders — and a sales rep
-- has no business reading somebody else's. The sales_orders policy decides.
-- -----------------------------------------------------------------------------
create or replace function public.product_committed_orders(p_product_id uuid)
returns table (
  sales_order_id uuid,
  number         text,
  status         sales_order_status,
  company_name   text,
  quantity       numeric
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    o.id,
    o.number,
    o.status,
    c.name,
    sum(sl.quantity)
  from sales_order_lines sl
  join sales_orders o on o.id = sl.sales_order_id
  left join companies c on c.id = o.company_id
  where sl.product_id = p_product_id
    and sl.organization_id = public.current_org_id()
    and public.sales_order_holds_stock(o.status)
    and o.deleted_at is null
  group by o.id, o.number, o.status, c.name
  order by o.number;
$$;

comment on function public.product_committed_orders(uuid) is
  'The signed orders holding a product, and how much each holds. Invoker: a rep sees their own.';

revoke execute on function public.product_committed_orders(uuid) from public, anon;
grant execute on function public.product_committed_orders(uuid) to authenticated, service_role;

-- =============================================================================
-- The seeded Won stage, which stopped meaning anything
--
-- Found while testing the above: a stage seeded into a brand new organization
-- has outcome 'open', including the one called Won.
--
-- 20260224_stage_outcome added the column, backfilled every existing stage by
-- name, and explained at length why a stage should carry what it means rather
-- than be matched on its name. It did not update the function that seeds them.
-- So the two organizations that existed at the time were fixed, and every
-- organization created since has had the original bug back:
--
--   "committed stock does not drop when I mark a deal won"
--
-- Dragging a deal into Won moves stage_id, deals_apply_stage_outcome reads
-- outcome 'open' and leaves the deal open, and the deal goes on holding stock,
-- inflating the pipeline and never getting a close date. The same symptom,
-- reintroduced by the fix's own blind spot.
--
-- Neither live organization is affected — both predate the backfill and were
-- corrected by it. This is for the next one.
-- =============================================================================

create or replace function public.organizations_seed_pipeline()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_pipeline uuid;
begin
  insert into pipelines (organization_id, name, is_default)
  values (new.id, 'Sales Pipeline', true)
  returning id into v_pipeline;

  -- Outcome is set here, not inferred from the name later. A seeded pipeline is
  -- the one case where the app knows exactly what each stage means, so leaving
  -- it to a backfill to guess was always the wrong way round.
  insert into stages (organization_id, pipeline_id, name, "order", default_probability, outcome)
  values
    (new.id, v_pipeline, 'New',           0, 0.100, 'open'),
    (new.id, v_pipeline, 'Qualified',     1, 0.250, 'open'),
    (new.id, v_pipeline, 'Proposal Sent', 2, 0.500, 'open'),
    (new.id, v_pipeline, 'Negotiation',   3, 0.750, 'open'),
    (new.id, v_pipeline, 'Won',           4, 1.000, 'won'),
    (new.id, v_pipeline, 'Lost',          5, 0.000, 'lost');

  return new;
end;
$$;

-- And any organization created between that migration and this one, matched by
-- name exactly as the original backfill did — the same guess, made once more,
-- where it is visible and correctable in Settings.
update stages set outcome = 'won'
where outcome = 'open' and lower(btrim(name)) = 'won';

update stages set outcome = 'lost'
where outcome = 'open' and lower(btrim(name)) = 'lost';
