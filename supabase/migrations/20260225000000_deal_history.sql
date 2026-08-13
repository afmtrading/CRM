-- =============================================================================
-- A deal is a permanent record
--
-- Three changes, all of them in service of one sentence: "I don't want to lose
-- any deals."
--
--   1. Deleting a deal stops destroying it. It is stamped and hidden, the way a
--      contact, a company and a product already are, and an administrator can
--      put it back.
--
--   2. A closed deal remembers who owned it at the moment it closed. Reassigning
--      the owner afterwards — which happens when somebody leaves, or an account
--      changes hands — no longer rewrites who won it.
--
--   3. A lost deal can say why it was lost, from a vocabulary the organization
--      writes for itself.
--
-- The reporting work that follows reads all three. None of it can be recovered
-- retrospectively, which is why this is the first thing built and not the last:
-- every day without it is a day of history that cannot be reconstructed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Soft delete
--
-- Same shape as contacts and companies: two columns, two partial indexes, and
-- the visibility rule gains a second half.
-- -----------------------------------------------------------------------------
alter table deals
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references users (id) on delete set null;

create index if not exists deals_live_idx
  on deals (organization_id) where deleted_at is null;
create index if not exists deals_deleted_idx
  on deals (organization_id, deleted_at desc) where deleted_at is not null;

comment on column deals.deleted_at is
  'Set by soft_delete_deal. A stamped deal leaves every view but an administrator''s and stops counting anywhere — committed stock, pipeline value, product mix.';

drop policy if exists deals_select on deals;
create policy deals_select on deals
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_see_owned(owner_id)
    and (deleted_at is null or public.is_org_admin())
  );

drop policy if exists deals_update on deals;
create policy deals_update on deals
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and public.can_see_owned(owner_id)
    and (deleted_at is null or public.is_org_admin())
  )
  with check (
    organization_id = public.current_org_id()
    and public.can_write_records()
  );

-- A hard delete is now only an administrator emptying the bin for good, exactly
-- as it is for contacts and companies.
drop policy if exists deals_delete on deals;
create policy deals_delete on deals
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());

/**
 * Deleting a deal.
 *
 * Definer for the reason every other soft delete is: under FORCE ROW LEVEL
 * SECURITY the updated row must still satisfy the SELECT policy, and a row that
 * has just been stamped fails it for everyone but an admin. A plain UPDATE
 * would be refused — by the very rule that makes the deletion work.
 */
create or replace function public.soft_delete_deal(p_deal_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_actor   uuid := public.current_app_user_id();
  v_visible boolean;
  v_name    text;
begin
  if not public.can_delete_records() then
    raise exception 'Your role does not allow deleting records';
  end if;

  select public.can_see_owned(owner_id), name
  into v_visible, v_name
  from public.deals
  where id = p_deal_id and organization_id = v_org and deleted_at is null;

  if v_visible is not true then
    raise exception 'Deal not found';
  end if;

  update public.deals
  set deleted_at = now(), deleted_by = v_actor
  where id = p_deal_id and organization_id = v_org;

  perform public.notify_admins(
    v_org,
    'deal_deleted',
    'Deal deleted: ' || coalesce(nullif(v_name, ''), 'unnamed deal'),
    coalesce((select name || ' (' || email || ')' from public.users where id = v_actor), 'Someone')
      || ' deleted this deal. It can still be restored.',
    '/settings/deleted'
  );
end;
$$;

create or replace function public.restore_deal(p_deal_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can restore a record';
  end if;

  update public.deals
  set deleted_at = null, deleted_by = null
  where id = p_deal_id and organization_id = public.current_org_id();
end;
$$;

revoke execute on function public.soft_delete_deal(uuid) from public, anon;
revoke execute on function public.restore_deal(uuid) from public, anon;
grant execute on function public.soft_delete_deal(uuid) to authenticated, service_role;
grant execute on function public.restore_deal(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- What a deleted deal stops counting towards
--
-- Row-level security hides it from the app's own queries, but four functions
-- read deals past that: two are SECURITY DEFINER and see everything by design,
-- and two are read by an administrator, for whom a deleted deal is still
-- visible. Left alone, a deleted deal would go on holding stock committed and
-- inflating the pipeline — which is the same class of bug as the Won stage that
-- did not mark deals won.
-- -----------------------------------------------------------------------------
create or replace function public.product_stock_summary(p_product_id uuid)
returns table (on_hand numeric, committed numeric, reserved numeric, available numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org       uuid := public.current_org_id();
  v_on_hand   numeric;
  v_reserved  numeric;
  v_committed numeric;
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
  into v_committed
  from deal_products dp
  join deals d on d.id = dp.deal_id
  where dp.product_id = p_product_id
    and d.status = 'open'
    -- A deleted deal has stopped promising anything. Until this migration the
    -- comment here said deals were never deleted; now they are.
    and d.deleted_at is null;

  return query select
    v_on_hand,
    v_committed,
    v_reserved,
    -- Deliberately not greatest(0, …): a negative available number means more
    -- has been promised than exists, which is the single most useful thing this
    -- function can tell anybody.
    v_on_hand - v_committed - v_reserved;
end;
$$;

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
  )
  select
    p.id,
    coalesce(placed.on_hand, 0),
    coalesce(promised.committed, 0),
    coalesce(placed.reserved, 0),
    coalesce(placed.on_hand, 0) - coalesce(promised.committed, 0) - coalesce(placed.reserved, 0),
    coalesce(placed.locations, array[]::text[])
  from products p
  left join placed on placed.product_id = p.id
  left join promised on promised.product_id = p.id
  where p.organization_id = public.current_org_id()
    and p.deleted_at is null;
$$;

create or replace function public.report_pipeline_value(
  p_pipeline_id uuid default null,
  p_owner_id    uuid default null
)
returns table (
  stage_id            uuid,
  stage_name          text,
  stage_order         integer,
  pipeline_id         uuid,
  pipeline_name       text,
  owner_id            uuid,
  owner_name          text,
  deal_count          bigint,
  total_value         numeric,
  weighted_value      numeric
)
language sql
stable
as $$
  select
    s.id,
    s.name,
    s."order",
    p.id,
    p.name,
    u.id,
    coalesce(u.name, u.email, 'Unassigned'),
    count(d.id),
    coalesce(sum(d.value), 0),
    coalesce(sum(d.value * d.probability), 0)
  from stages s
  join pipelines p on p.id = s.pipeline_id
  left join deals d
    on d.stage_id = s.id
   and d.status = 'open'
   and d.deleted_at is null
   and d.organization_id = public.current_org_id()
   and (p_owner_id is null or d.owner_id = p_owner_id)
  left join users u on u.id = d.owner_id
  where s.organization_id = public.current_org_id()
    and (p_pipeline_id is null or s.pipeline_id = p_pipeline_id)
  group by s.id, s.name, s."order", p.id, p.name, u.id, u.name, u.email
  order by p.name, s."order", coalesce(u.name, u.email);
$$;

create or replace function public.report_product_mix(
  p_pipeline_id uuid default null,
  p_status      deal_status default null
)
returns table (
  product_id     uuid,
  product_name   text,
  category       text,
  currency       text,
  deal_count     bigint,
  total_quantity numeric,
  total_value    numeric,
  weighted_value numeric,
  total_cost     numeric,
  margin         numeric
)
language sql
stable
as $$
  select
    p.id,
    p.name,
    p.category,
    d.currency,
    count(distinct d.id),
    coalesce(sum(dp.quantity), 0),
    coalesce(sum(dp.line_total), 0),
    coalesce(sum(dp.line_total * d.probability), 0),
    coalesce(sum(dp.line_cost), 0),
    coalesce(sum(dp.line_total - dp.line_cost), 0)
  from deal_products dp
  join deals d    on d.id = dp.deal_id
  join products p on p.id = dp.product_id
  join stages s   on s.id = d.stage_id
  where dp.organization_id = public.current_org_id()
    and d.deleted_at is null
    and (p_pipeline_id is null or s.pipeline_id = p_pipeline_id)
    and (p_status is null or d.status = p_status)
  group by p.id, p.name, p.category, d.currency
  order by coalesce(sum(dp.line_total), 0) desc, p.name;
$$;

-- -----------------------------------------------------------------------------
-- The side doors
--
-- Two definer functions take a deal id and change the deal. Being definer, they
-- do not consult the policy that now hides deleted rows, so each has to ask for
-- itself — otherwise a deal in the bin could still be repriced or handed to a
-- new owner by anyone holding its id. reassign_contact already tests
-- deleted_at; these are the deal equivalents, which had nothing to test until
-- now.
-- -----------------------------------------------------------------------------
create or replace function public.set_deal_value_from_products(p_deal_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_visible boolean;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow changing a deal';
  end if;

  select public.can_see_owned(owner_id) into v_visible
  from public.deals
  where id = p_deal_id and organization_id = v_org and deleted_at is null;

  if v_visible is not true then
    raise exception 'Deal not found';
  end if;

  update public.deals d
  set value_source = 'products',
      value = coalesce(
        (select sum(line_total) from public.deal_products where deal_id = d.id), 0
      )
  where d.id = p_deal_id and d.organization_id = v_org;
end;
$$;

create or replace function public.reassign_deal(p_deal_id uuid, p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_visible boolean;
begin
  if not public.can_bulk_records() then
    raise exception 'Your role does not allow assigning records';
  end if;

  select public.can_see_owned(owner_id) into v_visible
  from public.deals
  where id = p_deal_id and organization_id = v_org and deleted_at is null;

  if v_visible is not true then
    raise exception 'Deal not found';
  end if;

  if p_new_owner_id is not null and not exists (
    select 1 from public.users
    where id = p_new_owner_id and organization_id = v_org and status = 'active'
  ) then
    raise exception 'The new owner must be an active user in this organization';
  end if;

  update public.deals set owner_id = p_new_owner_id
  where id = p_deal_id and organization_id = v_org;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Who owned it when it closed
--
-- deals.owner_id is who owns it *now*, and that is the right answer for a
-- worklist: reassign an account and the new owner picks it up. It is the wrong
-- answer for a scoreboard, where moving an account would silently move last
-- quarter's wins with it.
--
-- So the close is stamped. Two columns, because they answer different
-- questions: whose number was it (closed_owner_id), and who pressed the button
-- (closed_by). They are usually the same person and occasionally not.
-- -----------------------------------------------------------------------------
alter table deals
  add column if not exists closed_owner_id uuid references users (id) on delete set null,
  add column if not exists closed_by       uuid references users (id) on delete set null,
  add column if not exists closed_at       timestamptz;

comment on column deals.closed_owner_id is
  'Who owned the deal at the moment it closed. Reporting reads this, not owner_id, so reassigning an account later does not move history with it.';

create index if not exists deals_closed_owner_idx
  on deals (organization_id, closed_owner_id, closed_at desc)
  where closed_at is not null;

/**
 * Stamps the close, and unstamps a reopening.
 *
 * Named to sort after deals_apply_stage_outcome and
 * deals_apply_stage_probability — both of them can still change `status` on
 * this row, and this has to read the final answer. Postgres fires BEFORE
 * triggers in name order, which is the whole reason those two are named as they
 * are.
 *
 * closed_at is its own column rather than a reuse of actual_close_date: that
 * one is a date the user may edit to say when the business actually closed,
 * while this is the system's record of when the row changed.
 */
create or replace function public.deals_stamp_close()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('won', 'lost') then
    -- Only on the transition. A won deal edited a month later keeps the owner
    -- it was won by, which is the entire point of the column.
    if tg_op = 'INSERT' or old.status is distinct from new.status then
      new.closed_owner_id := new.owner_id;
      new.closed_by       := public.current_app_user_id();
      new.closed_at       := now();
    end if;

  elsif tg_op = 'UPDATE' and old.status is distinct from new.status then
    -- Reopened. The close did not happen, so nothing should claim it did.
    new.closed_owner_id := null;
    new.closed_by       := null;
    new.closed_at       := null;
    new.loss_reason     := null;
  end if;

  return new;
end;
$$;

-- 3. Why it was lost
--
-- Free-standing text validated against field_options rather than a check
-- constraint, for the reason the product vocabularies moved there: "Price" and
-- "Timing" are an organization's own words, and adding one should not need a
-- deployment. Left unvalidated in the database on purpose — the form offers the
-- list, and an import that carries an unfamiliar reason should keep it rather
-- than lose it.
alter table deals
  add column if not exists loss_reason text;

comment on column deals.loss_reason is
  'Why a lost deal was lost. Offered from field_options (deal / loss_reason); cleared automatically if the deal is reopened.';

create index if not exists deals_loss_reason_idx
  on deals (organization_id, loss_reason)
  where loss_reason is not null;

drop trigger if exists deals_stamp_close on deals;
create trigger deals_stamp_close
  before insert or update on deals
  for each row execute function public.deals_stamp_close();

-- Deals that closed before today were never stamped. The best available answer
-- is the current owner and the recorded close date: imperfect for any deal
-- reassigned since, and far better than a column of nulls that reporting would
-- have to treat as "unknown owner" forever.
update deals
set closed_owner_id = owner_id,
    closed_at = coalesce(actual_close_date::timestamptz, updated_at)
where status in ('won', 'lost')
  and closed_at is null;

-- -----------------------------------------------------------------------------
-- The starting vocabulary for loss reasons
--
-- Generic on purpose, like every other seeded list: a starting point an
-- organization is expected to rewrite, not a taxonomy this app is asserting.
-- -----------------------------------------------------------------------------
create or replace function seed_field_options(p_organization_id uuid)
returns void
language sql
as $$
  insert into field_options (organization_id, entity_type, field_key, value, color, "order")
  select p_organization_id, d.entity_type::filter_entity_type, d.field_key, d.value, d.color, d.ord
  from (values
    ('company', 'specialty_market', 'Foodservice',    'blue',   1),
    ('company', 'specialty_market', 'Retail',         'green',  2),
    ('company', 'specialty_market', 'Wholesale',      'violet', 3),
    ('company', 'specialty_market', 'Industrial',     'orange', 4),
    ('company', 'specialty_market', 'Export',         'cyan',   5),

    ('company', 'customer_type',    'Distributor',    'blue',   1),
    ('company', 'customer_type',    'Broker',         'violet', 2),
    ('company', 'customer_type',    'Manufacturer',   'teal',   3),
    ('company', 'customer_type',    'Retailer',       'green',  4),
    ('company', 'customer_type',    'End user',       'slate',  5),

    ('contact', 'role_type',        'Decision maker', 'green',  1),
    ('contact', 'role_type',        'Influencer',     'blue',   2),
    ('contact', 'role_type',        'Champion',       'violet', 3),
    ('contact', 'role_type',        'Gatekeeper',     'amber',  4),
    ('contact', 'role_type',        'Technical buyer','cyan',   5),
    ('contact', 'role_type',        'End user',       'slate',  6),

    ('contact', 'priority',         'Low',            'slate',  1),
    ('contact', 'priority',         'Standard',       'blue',   2),
    ('contact', 'priority',         'High',           'amber',  3),
    ('contact', 'priority',         'Critical',       'red',    4),

    ('contact', 'credibility',      'Unverified',     'slate',  1),
    ('contact', 'credibility',      'Developing',     'amber',  2),
    ('contact', 'credibility',      'Trusted',        'green',  3),
    ('contact', 'credibility',      'Highly trusted', 'teal',   4),

    ('product', 'product_type',     'Item',           'slate',  1),
    ('product', 'product_type',     'Case',           'blue',   2),
    ('product', 'product_type',     'Pallet',         'violet', 3),
    ('product', 'product_type',     'Kit',            'teal',   4),
    ('product', 'product_type',     'Bin',            'orange', 5),

    ('product', 'product_condition', 'New',           'green',  1),
    ('product', 'product_condition', 'Open Box',      'blue',   2),
    ('product', 'product_condition', 'Damaged',       'red',    3),
    ('product', 'product_condition', 'Refurbished',   'violet', 4),
    ('product', 'product_condition', 'Expired',       'amber',  5),

    ('product', 'product_status',   'Active',         'green',  1),
    ('product', 'product_status',   'Inactive',       'slate',  2),
    ('product', 'product_status',   'Discontinued',   'slate',  3),
    ('product', 'product_status',   'Quarantined',    'amber',  4),
    ('product', 'product_status',   'Sold',           'blue',   5),

    ('deal',    'loss_reason',      'Price',              'red',    1),
    ('deal',    'loss_reason',      'Lost to competitor', 'orange', 2),
    ('deal',    'loss_reason',      'Timing',             'amber',  3),
    ('deal',    'loss_reason',      'No budget',          'violet', 4),
    ('deal',    'loss_reason',      'No decision',        'slate',  5),
    ('deal',    'loss_reason',      'Product fit',        'blue',   6),
    ('deal',    'loss_reason',      'Stock unavailable',  'cyan',   7),
    ('deal',    'loss_reason',      'No response',        'slate',  8)
  ) as d(entity_type, field_key, value, color, ord)
  on conflict do nothing;
$$;

select seed_field_options(id) from organizations;
