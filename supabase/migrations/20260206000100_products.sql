-- =============================================================================
-- Products
--
-- Until now a deal recorded who and how much but never what. A $40,000 deal was
-- a number, so nothing could answer "how much shea did we quote this quarter"
-- or "which clients buy cocoa powder".
--
-- Three tables do the work:
--
--   products         the catalogue — org-wide reference data, like pipelines
--   deal_products    line items — what a deal is actually for, and at what price
--   contact_products what a person has asked about, which is intent, not history
--
-- A deal's value now follows its line items unless someone has priced it by
-- hand. That rule lives in one trigger and is explained where it is written.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Preconditions
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.can_manage_records()') is null
     or to_regprocedure('public.notify_admins(uuid, text, text, text, text)') is null then
    raise exception
      'Run the 20260204 and 20260205 migrations first — this one builds on their role predicates.';
  end if;

  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'filter_entity_type' and e.enumlabel = 'product'
  ) then
    raise exception 'Run 20260206000000_product_entity_type.sql first.';
  end if;
end
$$;

-- A product's fields divide into what it is and what it costs, so the card
-- vocabulary gains one value. Contacts and companies never offer it.
alter table custom_field_definitions drop constraint if exists custom_field_definitions_card_check;
alter table custom_field_definitions add constraint custom_field_definitions_card_check
  check (card in ('details', 'influence', 'additional', 'digital', 'pricing'));

-- -----------------------------------------------------------------------------
-- The catalogue
--
-- Category is not a column of its own vocabulary: it draws from field_options
-- like every other select field, so it is edited in Settings → Fields with the
-- same colours and the same editor as everything else.
-- -----------------------------------------------------------------------------
create table if not exists products (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name            text not null,
  /** The organization's own code for the product. Optional, unique when set. */
  sku             text,
  category        text,
  /** kg, MT, container, licence — whatever the line item is counted in. */
  unit            text not null default '',
  unit_price      numeric(14, 2) not null default 0 check (unit_price >= 0),
  /** What it costs us. Drives margin on the product mix report. */
  unit_cost       numeric(14, 2) not null default 0 check (unit_cost >= 0),
  currency        text not null default 'CAD',
  /** Markdown, rendered through renderMarkdown() — never raw HTML. */
  description     text,
  custom_fields   jsonb not null default '{}'::jsonb,
  /** Retired but still on old deals. The everyday alternative to deleting. */
  active          boolean not null default true,
  created_by      uuid references users (id) on delete set null,
  updated_by      uuid references users (id) on delete set null,
  deleted_at      timestamptz,
  deleted_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table products is
  'Sellable products. Org-wide reference data: everyone reads, admins and managers write.';

create index if not exists products_org_idx on products (organization_id);
create index if not exists products_org_name_idx on products (organization_id, lower(name));
create index if not exists products_category_idx on products (organization_id, category);
create index if not exists products_live_idx
  on products (organization_id) where deleted_at is null;
create index if not exists products_deleted_idx
  on products (organization_id, deleted_at desc) where deleted_at is not null;
create index if not exists products_custom_fields_idx on products using gin (custom_fields);

-- A SKU identifies one live product. Deleted rows are excluded so a code can be
-- reused after the product it belonged to has been removed.
create unique index if not exists products_org_sku_idx
  on products (organization_id, lower(sku))
  where sku is not null and sku <> '' and deleted_at is null;

create trigger products_updated_at
  before update on products
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- Line items
--
-- unit_price and unit_cost are copied from the product when the line is added
-- and then left alone. Re-pricing the catalogue next year must not rewrite what
-- last year's closed deals were worth — that is the whole difference between a
-- product catalogue and an accounting problem.
--
-- There is no currency here: a line item is denominated in its deal's currency.
-- Mixing currencies inside one deal would make its total meaningless, and the
-- product's own currency is only a default for the copied price.
-- -----------------------------------------------------------------------------
create table if not exists deal_products (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  deal_id         uuid not null references deals (id) on delete cascade,
  -- restrict, not cascade: removing a product must never quietly change what a
  -- deal was worth. Products are retired or soft-deleted instead.
  product_id      uuid not null references products (id) on delete restrict,
  quantity        numeric(14, 3) not null default 1 check (quantity >= 0),
  unit_price      numeric(14, 2) not null default 0 check (unit_price >= 0),
  unit_cost       numeric(14, 2) not null default 0 check (unit_cost >= 0),
  discount_pct    numeric(5, 2) not null default 0
    check (discount_pct >= 0 and discount_pct <= 100),
  line_total      numeric(14, 2)
    generated always as (round(quantity * unit_price * (1 - discount_pct / 100), 2)) stored,
  line_cost       numeric(14, 2)
    generated always as (round(quantity * unit_cost, 2)) stored,
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists deal_products_deal_idx on deal_products (deal_id, position);
create index if not exists deal_products_product_idx on deal_products (organization_id, product_id);

create trigger deal_products_updated_at
  before update on deal_products
  for each row execute function set_updated_at();

-- Both ends of a line item must belong to the line item's own organization —
-- the same guard deals_validate_stage applies to a deal's stage.
create or replace function deal_products_validate_parents()
returns trigger
language plpgsql
as $$
declare
  v_deal_org    uuid;
  v_product_org uuid;
begin
  select organization_id into v_deal_org from deals where id = new.deal_id;
  select organization_id into v_product_org from products where id = new.product_id;

  if v_deal_org is distinct from new.organization_id then
    raise exception 'deal % does not belong to organization %', new.deal_id, new.organization_id;
  end if;

  if v_product_org is distinct from new.organization_id then
    raise exception 'product % does not belong to organization %', new.product_id, new.organization_id;
  end if;

  return new;
end;
$$;

create trigger deal_products_validate_parents
  before insert or update of deal_id, product_id, organization_id on deal_products
  for each row execute function deal_products_validate_parents();

-- -----------------------------------------------------------------------------
-- Where a deal's value comes from
--
-- 'products' means the value is the sum of the line items and is kept in step
-- automatically. 'manual' means somebody typed it. Every existing deal is
-- manual, because somebody did.
-- -----------------------------------------------------------------------------
alter table deals
  add column if not exists value_source text not null default 'manual';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deals_value_source_check') then
    alter table deals add constraint deals_value_source_check
      check (value_source in ('manual', 'products'));
  end if;
end
$$;

/**
 * Keeps deals.value in step with its line items.
 *
 * security definer for the reason every write in this schema needs one: under
 * FORCE ROW LEVEL SECURITY the updated row must still satisfy the deal's own
 * UPDATE policy, and a line item can legitimately be edited by someone whose
 * hold on the parent deal is narrower than a full update. The authorisation
 * that matters already happened — RLS on deal_products only admits a row whose
 * deal the caller can see and write.
 */
create or replace function public.deal_products_sync_value()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deal  uuid := coalesce(new.deal_id, old.deal_id);
  v_prior uuid := case when tg_op = 'UPDATE' then old.deal_id end;
begin
  -- A deal nobody has priced adopts its line items the moment the first one
  -- lands. A deal that already carries a typed value keeps it, and the record
  -- shows the disagreement rather than overwriting the number behind someone's
  -- back.
  if tg_op = 'INSERT' then
    update public.deals
    set value_source = 'products'
    where id = v_deal and value_source = 'manual' and value = 0;
  end if;

  update public.deals d
  set value = coalesce(
    (select sum(line_total) from public.deal_products where deal_id = d.id), 0
  )
  where d.id in (v_deal, v_prior) and d.value_source = 'products';

  return null;
end;
$$;

create trigger deal_products_sync_value
  after insert or update or delete on deal_products
  for each row execute function public.deal_products_sync_value();

/** The "use the line items" button on a deal. */
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
  where id = p_deal_id and organization_id = v_org;

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

-- -----------------------------------------------------------------------------
-- What a contact is interested in
--
-- Intent, not history: "asked about organic certification". What a client has
-- actually bought is derived from won deals and never stored twice.
-- -----------------------------------------------------------------------------
create table if not exists contact_products (
  organization_id uuid not null references organizations (id) on delete cascade,
  contact_id      uuid not null references contacts (id) on delete cascade,
  product_id      uuid not null references products (id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (contact_id, product_id)
);

create index if not exists contact_products_product_idx
  on contact_products (organization_id, product_id);

-- -----------------------------------------------------------------------------
-- Grants
--
-- The blanket grant in the original RLS migration only covered the tables that
-- existed then; every table added since needs its own.
-- -----------------------------------------------------------------------------
revoke all on products from anon;
revoke all on deal_products from anon;
revoke all on contact_products from anon;

grant select, insert, update, delete on products to authenticated;
grant select, insert, update, delete on deal_products to authenticated;
grant select, insert, update, delete on contact_products to authenticated;

alter table products enable row level security;
alter table products force row level security;
alter table deal_products enable row level security;
alter table deal_products force row level security;
alter table contact_products enable row level security;
alter table contact_products force row level security;

-- -----------------------------------------------------------------------------
-- Who may do what
--
-- The catalogue is shared reference data, so it follows pipelines and tags
-- rather than contacts: everyone reads it, admins and managers change it,
-- ownership does not apply.
--
-- A deleted product stays readable on purpose, unlike a deleted contact. A line
-- item on a closed deal has to keep rendering its product's name, and a
-- discontinued SKU is not confidential the way a relationship is. Lists and
-- pickers filter deleted rows out; the recycle bin is where they resurface.
-- -----------------------------------------------------------------------------
drop policy if exists products_select on products;
create policy products_select on products
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists products_insert on products;
create policy products_insert on products
  for insert to authenticated
  with check (organization_id = public.current_org_id() and public.can_manage_records());

drop policy if exists products_update on products;
create policy products_update on products
  for update to authenticated
  using (organization_id = public.current_org_id() and public.can_manage_records())
  with check (organization_id = public.current_org_id() and public.can_manage_records());

-- A hard delete is reserved for an administrator emptying the bin for good.
drop policy if exists products_delete on products;
create policy products_delete on products
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());

-- Line items follow the deal they belong to: if you can see the deal you can
-- see what it is for, and if you can write it you can price it. Stating the
-- rule through `exists` means it cannot drift from the deals policy.
drop policy if exists deal_products_select on deal_products;
create policy deal_products_select on deal_products
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and exists (select 1 from deals d where d.id = deal_products.deal_id)
  );

drop policy if exists deal_products_write on deal_products;
create policy deal_products_write on deal_products
  for all to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and exists (select 1 from deals d where d.id = deal_products.deal_id)
  )
  with check (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and exists (select 1 from deals d where d.id = deal_products.deal_id)
  );

drop policy if exists contact_products_select on contact_products;
create policy contact_products_select on contact_products
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and exists (select 1 from contacts c where c.id = contact_products.contact_id)
  );

drop policy if exists contact_products_write on contact_products;
create policy contact_products_write on contact_products
  for all to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and exists (select 1 from contacts c where c.id = contact_products.contact_id)
  )
  with check (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and exists (select 1 from contacts c where c.id = contact_products.contact_id)
  );

-- -----------------------------------------------------------------------------
-- Deleting and restoring a product
--
-- The definer function is what raises the notice: notify_admins is granted to
-- service_role alone, so nobody can post a notification of their own invention.
-- -----------------------------------------------------------------------------
create or replace function public.soft_delete_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   uuid := public.current_org_id();
  v_actor uuid := public.current_app_user_id();
  v_name  text;
begin
  if not public.can_manage_records() then
    raise exception 'Only an administrator or manager can delete a product';
  end if;

  select name into v_name
  from public.products
  where id = p_product_id and organization_id = v_org and deleted_at is null;

  if v_name is null then
    raise exception 'Product not found';
  end if;

  update public.products
  set deleted_at = now(), deleted_by = v_actor
  where id = p_product_id and organization_id = v_org;

  perform public.notify_admins(
    v_org,
    'product_deleted',
    'Product deleted: ' || v_name,
    coalesce((select name || ' (' || email || ')' from public.users where id = v_actor), 'Someone')
      || ' deleted this product. Deals that already list it keep their prices.',
    '/settings/deleted'
  );
end;
$$;

create or replace function public.restore_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can restore a record';
  end if;

  update public.products
  set deleted_at = null, deleted_by = null
  where id = p_product_id and organization_id = public.current_org_id();
end;
$$;

-- -----------------------------------------------------------------------------
-- What are we actually selling
--
-- The pipeline report answers "how much is in play". This answers "of what".
-- Totals are grouped by currency as well as by product: adding CAD to EUR would
-- produce a number that means nothing.
--
-- Deliberately not security definer — it reads through the caller's own
-- policies, so a sales rep's product mix covers their own deals and no others,
-- exactly as report_pipeline_value already behaves.
-- -----------------------------------------------------------------------------
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
    and (p_pipeline_id is null or s.pipeline_id = p_pipeline_id)
    and (p_status is null or d.status = p_status)
  group by p.id, p.name, p.category, d.currency
  order by coalesce(sum(dp.line_total), 0) desc, p.name;
$$;

revoke execute on function public.deal_products_sync_value() from public;
revoke execute on function public.set_deal_value_from_products(uuid) from public;
revoke execute on function public.soft_delete_product(uuid) from public;
revoke execute on function public.restore_product(uuid) from public;

grant execute on function public.set_deal_value_from_products(uuid) to authenticated, service_role;
grant execute on function public.soft_delete_product(uuid) to authenticated, service_role;
grant execute on function public.restore_product(uuid) to authenticated, service_role;
grant execute on function public.report_product_mix(uuid, deal_status) to authenticated;
