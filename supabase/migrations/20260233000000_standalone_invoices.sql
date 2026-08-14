-- =============================================================================
-- Invoices raised on their own, and the stock they hold
--
-- The schema has always allowed a standalone invoice — sales_order_id is
-- nullable and the detail page says "Raised on its own" when it is null — but
-- nothing could make one. This adds the way in.
--
-- COMPOSING A DOCUMENT THAT IS SUPPOSED TO BE FROZEN
--
-- An invoice is a snapshot, and invoice_lines has SELECT and no write policy so
-- that nothing can quietly restate what a document said. A hand-built invoice
-- has to be composed before it is issued, which is the one case that rule did
-- not anticipate.
--
-- Resolved by narrowing rather than relaxing: lines are written through the
-- functions below, which refuse unless the invoice is a draft AND has no sales
-- order behind it. So a converted invoice's lines stay exactly as the order left
-- them, an issued invoice's lines stay as the customer received them, and the
-- only editable document is one that has never left the building. The table
-- still has no write policy — there is no statement anybody can send that edits
-- an invoice line directly.
--
-- The money rule stays in one place too: the functions take the revised rate and
-- compute the discount with sales_line_discount(), the same function the sales
-- order lines' trigger uses. Nothing sends a discount.
--
-- STOCK
--
-- A standalone invoice holds stock. An invoice raised from a sales order does
-- not — the order is already holding it, and counting both would commit the
-- same pallet twice. `sales_order_id is null` is the whole test.
--
--   draft    no. Being written; commits to nothing, as with an order.
--   sent     yes. Issued and awaiting settlement.
--   partial  yes. Same, part paid.
--   paid     no. The transaction is closed. Holding stock for every invoice
--            ever settled would commit the warehouse a slice at a time.
--   void     no.
--
-- The paid boundary is the one judgement here. If goods routinely leave after
-- payment rather than before, paid should hold too — and that is a one-line
-- change to invoice_holds_stock() below, which is why it is a function and not
-- a predicate spelled out in three places.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Raising one
-- -----------------------------------------------------------------------------
create or replace function public.create_invoice(
  p_company_id uuid default null,
  p_contact_id uuid default null,
  p_owner_id   uuid default null,
  p_currency   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   uuid := public.current_org_id();
  v_actor uuid := public.current_app_user_id();
  v_owner uuid;
  v_id    uuid;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow raising an invoice';
  end if;

  if p_company_id is not null and not exists (
    select 1 from public.companies where id = p_company_id and organization_id = v_org
  ) then
    raise exception 'Company not found';
  end if;

  -- Unowned invoices are invisible to a rep under can_see_owned, so the person
  -- raising it is the sensible default rather than nobody.
  v_owner := coalesce(p_owner_id, v_actor);

  insert into public.invoices (
    organization_id, number, company_id, contact_id, owner_id, owner_name,
    status, currency, issue_date, created_by
  )
  values (
    v_org,
    public.next_document_number(v_org, 'INV', null),
    p_company_id,
    p_contact_id,
    v_owner,
    (select coalesce(name, email) from public.users where id = v_owner),
    'draft',
    coalesce(nullif(p_currency, ''), 'CAD'),
    current_date,
    v_actor
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_invoice(uuid, uuid, uuid, text) is
  'Raises an empty draft invoice with no sales order behind it. The number is allocated in the same transaction as the row.';

-- -----------------------------------------------------------------------------
-- Totals follow the lines
--
-- subtotal and total are stored, because an invoice is a snapshot. Stored is not
-- the same as typed: they are recomputed from the lines whenever the lines
-- change, so a document can never show a total that its own rows do not add up
-- to. On a converted or issued invoice the lines never change, so this never
-- fires for them.
-- -----------------------------------------------------------------------------
create or replace function public.invoice_lines_sync_total()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
  v_subtotal numeric;
  v_total    numeric;
begin
  select coalesce(sum(line_total), 0) into v_subtotal
  from public.invoice_lines where invoice_id = v_invoice;

  update public.invoices
  set subtotal = v_subtotal,
      total = round(v_subtotal + shipping_charge, 2),
      status = public.invoice_status_for(
        round(v_subtotal + shipping_charge, 2), amount_paid, status
      )
  where id = v_invoice
  returning total into v_total;

  return null;
end;
$$;

drop trigger if exists invoice_lines_total on invoice_lines;
create trigger invoice_lines_total
  after insert or update or delete on invoice_lines
  for each row execute function public.invoice_lines_sync_total();

/**
 * Shipping moves the total too, and it is an ordinary column an ordinary update
 * can reach — so the same recomputation has to hang off the header.
 */
create or replace function public.invoices_sync_total()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.shipping_charge is distinct from old.shipping_charge then
    new.total := round(new.subtotal + new.shipping_charge, 2);
    new.status := public.invoice_status_for(new.total, new.amount_paid, new.status);
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_total on invoices;
create trigger invoices_total
  before update of shipping_charge on invoices
  for each row execute function public.invoices_sync_total();

-- -----------------------------------------------------------------------------
-- Lines on a draft invoice
--
-- The only door onto invoice_lines that is not the conversion. Both functions
-- start by establishing that this document may still be written to at all.
-- -----------------------------------------------------------------------------

/** Raises unless the invoice is a draft that was raised on its own. */
create or replace function public.assert_invoice_editable(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice invoices%rowtype;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow changing an invoice';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = public.current_org_id();

  if v_invoice.id is null or not public.can_see_owned(v_invoice.owner_id) then
    raise exception 'Invoice not found';
  end if;
  if v_invoice.sales_order_id is not null then
    raise exception 'This invoice came from % — change the order, not the invoice',
      (select number from public.sales_orders where id = v_invoice.sales_order_id);
  end if;
  if v_invoice.status <> 'draft' then
    raise exception 'This invoice has been issued. Void it and raise another.';
  end if;
end;
$$;

create or replace function public.add_invoice_line(
  p_invoice_id  uuid,
  p_product_id  uuid default null,
  p_name        text default null,
  p_quantity    numeric default 1,
  p_unit_price  numeric default 0,
  p_unit_cost   numeric default 0,
  p_rate_type   revised_rate_type default null,
  p_rate        numeric default null,
  p_notes       text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org      uuid := public.current_org_id();
  v_product  products%rowtype;
  v_name     text;
  v_discount numeric;
  v_position integer;
  v_id       uuid;
begin
  perform public.assert_invoice_editable(p_invoice_id);

  if p_product_id is not null then
    select * into v_product
    from public.products where id = p_product_id and organization_id = v_org;

    if v_product.id is null then
      raise exception 'Product not found';
    end if;
  end if;

  -- The name is a snapshot from the moment the line is added, exactly as it is
  -- on a converted invoice: renaming the product later must not rewrite it.
  v_name := coalesce(nullif(btrim(v_product.name), ''), nullif(btrim(p_name), ''));
  if v_name is null then
    raise exception 'A line needs a product or a description';
  end if;

  -- One definition of the money, shared with the sales order lines' trigger.
  v_discount := public.sales_line_discount(p_quantity, p_unit_price, p_rate_type, p_rate);

  select coalesce(max(position) + 1, 0) into v_position
  from public.invoice_lines where invoice_id = p_invoice_id;

  insert into public.invoice_lines (
    organization_id, invoice_id, product_id, name, sku, notes,
    quantity, unit_price, unit_cost, discount, line_total, position
  )
  values (
    v_org, p_invoice_id, p_product_id, v_name, v_product.sku, nullif(btrim(p_notes), ''),
    p_quantity, p_unit_price,
    coalesce(nullif(p_unit_cost, 0), v_product.unit_cost, 0),
    v_discount,
    round(p_quantity * p_unit_price, 2) - v_discount,
    v_position
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.remove_invoice_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice uuid;
begin
  select invoice_id into v_invoice
  from public.invoice_lines
  where id = p_line_id and organization_id = public.current_org_id();

  if v_invoice is null then
    raise exception 'Line not found';
  end if;

  perform public.assert_invoice_editable(v_invoice);

  delete from public.invoice_lines where id = p_line_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- The stock a standalone invoice holds
-- -----------------------------------------------------------------------------
create or replace function public.invoice_holds_stock(p_status invoice_status)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select p_status in ('sent', 'partial');
$$;

comment on function public.invoice_holds_stock(invoice_status) is
  'Whether an invoice at this status is a live claim on goods not yet handed over. Only applies to invoices with no sales order behind them.';

drop function if exists public.product_stock_summary(uuid);

create function public.product_stock_summary(p_product_id uuid)
returns table (
  on_hand            numeric,
  committed          numeric,
  committed_deals    numeric,
  committed_orders   numeric,
  /** Standalone invoices only — one from an order is counted under the order. */
  committed_invoices numeric,
  reserved           numeric,
  available          numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org      uuid := public.current_org_id();
  v_on_hand  numeric;
  v_reserved numeric;
  v_deals    numeric;
  v_orders   numeric;
  v_invoices numeric;
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
    and d.deleted_at is null;

  select coalesce(sum(sl.quantity), 0)
  into v_orders
  from sales_order_lines sl
  join sales_orders o on o.id = sl.sales_order_id
  where sl.product_id = p_product_id
    and public.sales_order_holds_stock(o.status)
    and o.deleted_at is null;

  select coalesce(sum(il.quantity), 0)
  into v_invoices
  from invoice_lines il
  join invoices i on i.id = il.invoice_id
  where il.product_id = p_product_id
    -- An invoice from an order would double-count what the order already holds.
    and i.sales_order_id is null
    and public.invoice_holds_stock(i.status);

  return query select
    v_on_hand,
    v_deals + v_orders + v_invoices,
    v_deals,
    v_orders,
    v_invoices,
    v_reserved,
    v_on_hand - v_deals - v_orders - v_invoices - v_reserved;
end;
$$;

revoke execute on function public.product_stock_summary(uuid) from public, anon;
grant execute on function public.product_stock_summary(uuid) to authenticated, service_role;

drop function if exists public.product_stock_overview();

create function public.product_stock_overview()
returns table (
  product_id         uuid,
  on_hand            numeric,
  committed          numeric,
  committed_deals    numeric,
  committed_orders   numeric,
  committed_invoices numeric,
  reserved           numeric,
  available          numeric,
  locations          text[]
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
  ),
  ordered as (
    select sl.product_id, sum(sl.quantity) as committed
    from sales_order_lines sl
    join sales_orders o on o.id = sl.sales_order_id
    where sl.organization_id = public.current_org_id()
      and public.sales_order_holds_stock(o.status)
      and o.deleted_at is null
    group by sl.product_id
  ),
  billed as (
    select il.product_id, sum(il.quantity) as committed
    from invoice_lines il
    join invoices i on i.id = il.invoice_id
    where il.organization_id = public.current_org_id()
      and i.sales_order_id is null
      and public.invoice_holds_stock(i.status)
    group by il.product_id
  )
  select
    p.id,
    coalesce(placed.on_hand, 0),
    coalesce(promised.committed, 0) + coalesce(ordered.committed, 0) + coalesce(billed.committed, 0),
    coalesce(promised.committed, 0),
    coalesce(ordered.committed, 0),
    coalesce(billed.committed, 0),
    coalesce(placed.reserved, 0),
    coalesce(placed.on_hand, 0)
      - coalesce(promised.committed, 0)
      - coalesce(ordered.committed, 0)
      - coalesce(billed.committed, 0)
      - coalesce(placed.reserved, 0),
    coalesce(placed.locations, array[]::text[])
  from products p
  left join placed on placed.product_id = p.id
  left join promised on promised.product_id = p.id
  left join ordered on ordered.product_id = p.id
  left join billed on billed.product_id = p.id
  where p.organization_id = public.current_org_id()
    and p.deleted_at is null;
$$;

revoke execute on function public.product_stock_overview() from public, anon;
grant execute on function public.product_stock_overview() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Which documents hold a product
--
-- Orders and standalone invoices in one list, because from the warehouse's side
-- they are the same thing: a piece of paper that has spoken for stock.
-- -----------------------------------------------------------------------------
drop function if exists public.product_committed_orders(uuid);

create function public.product_committed_orders(p_product_id uuid)
returns table (
  kind         text,
  document_id  uuid,
  number       text,
  status       text,
  company_name text,
  quantity     numeric
)
language sql
stable
set search_path = public, pg_temp
as $$
  select 'order', o.id, o.number, o.status::text, c.name, sum(sl.quantity)
  from sales_order_lines sl
  join sales_orders o on o.id = sl.sales_order_id
  left join companies c on c.id = o.company_id
  where sl.product_id = p_product_id
    and sl.organization_id = public.current_org_id()
    and public.sales_order_holds_stock(o.status)
    and o.deleted_at is null
  group by o.id, o.number, o.status, c.name

  union all

  select 'invoice', i.id, i.number, i.status::text, c.name, sum(il.quantity)
  from invoice_lines il
  join invoices i on i.id = il.invoice_id
  left join companies c on c.id = i.company_id
  where il.product_id = p_product_id
    and il.organization_id = public.current_org_id()
    and i.sales_order_id is null
    and public.invoice_holds_stock(i.status)
  group by i.id, i.number, i.status, c.name

  order by 3;
$$;

comment on function public.product_committed_orders(uuid) is
  'The orders and standalone invoices holding a product. Invoker: a rep sees their own.';

revoke execute on function public.product_committed_orders(uuid) from public, anon;
grant execute on function public.product_committed_orders(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke execute on function public.create_invoice(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.create_invoice(uuid, uuid, uuid, text) to authenticated, service_role;

revoke execute on function
  public.add_invoice_line(uuid, uuid, text, numeric, numeric, numeric, revised_rate_type, numeric, text)
  from public, anon;
grant execute on function
  public.add_invoice_line(uuid, uuid, text, numeric, numeric, numeric, revised_rate_type, numeric, text)
  to authenticated, service_role;

revoke execute on function public.remove_invoice_line(uuid) from public, anon;
grant execute on function public.remove_invoice_line(uuid) to authenticated, service_role;

-- Internal: called by the two above, never over the wire.
revoke execute on function public.assert_invoice_editable(uuid) from public, anon, authenticated;
revoke execute on function public.invoice_lines_sync_total() from public, anon, authenticated;
revoke execute on function public.invoices_sync_total() from public, anon, authenticated;
