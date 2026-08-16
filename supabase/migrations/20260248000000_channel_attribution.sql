-- =============================================================================
-- Which channel a sale went through
--
-- The marketplace records say what each channel is and what it costs. Nothing
-- said which sales went through one, so the two could not be put together: "we
-- sold £40k through B-Stock last quarter and it cost us a fifth of it" was a
-- question the CRM held both halves of and could not answer.
--
-- One nullable column on each document. Null is the ordinary case — a direct
-- sale to a buyer is not a channel sale — and making it nullable rather than
-- defaulting to something is what keeps "sold direct" and "nobody recorded it"
-- from being the same value.
--
-- WHY IT POINTS AT THE COMPANY
--
-- Not at marketplace_profiles, which is what it is a channel *by*. A profile
-- can be removed — that is the whole point of it being separable — and an order
-- sold through B-Stock in March was still sold through B-Stock after somebody
-- stops listing there in June. Pointing at the company makes the attribution a
-- historical fact rather than a live one; the trigger below is what insists it
-- is a real channel at the moment it is recorded.
-- =============================================================================

alter table public.sales_orders
  add column if not exists marketplace_id uuid references public.companies (id) on delete restrict;

alter table public.invoices
  add column if not exists marketplace_id uuid references public.companies (id) on delete restrict;

comment on column public.sales_orders.marketplace_id is
  'The channel this sold through, or null for a direct sale. Points at the company, not its marketplace profile, so the attribution survives the channel being retired.';
comment on column public.invoices.marketplace_id is
  'Carried from the sales order on conversion, or set directly on a standalone invoice.';

create index if not exists sales_orders_marketplace_idx
  on public.sales_orders (organization_id, marketplace_id) where marketplace_id is not null;
create index if not exists invoices_marketplace_idx
  on public.invoices (organization_id, marketplace_id) where marketplace_id is not null;

-- -----------------------------------------------------------------------------
-- It has to be a channel you sell through
--
-- Two things are refused. A company with no marketplace profile, because
-- attributing a sale to a channel that is not one is a typo with a plausible
-- shape — every company is in the same picker. And a profile marked
-- source-only: money running the other way is a purchase, not a sale, and
-- recording it here would put it into channel revenue.
--
-- Checked on write rather than by a foreign key, because the fact being
-- asserted — "this was a selling channel when the order was raised" — is not
-- one a constraint can express and not one that should be re-checked later.
-- -----------------------------------------------------------------------------
create or replace function public.documents_check_marketplace()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sells boolean;
begin
  if new.marketplace_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.marketplace_id is not distinct from old.marketplace_id then
    return new;
  end if;

  select p.sells_through into v_sells
  from public.marketplace_profiles p
  where p.company_id = new.marketplace_id
    and p.organization_id = new.organization_id;

  if v_sells is null then
    raise exception 'That company is not a marketplace';
  end if;

  if v_sells is false then
    raise exception 'That marketplace is marked source-only — money running the other way is a purchase, not a sale';
  end if;

  return new;
end;
$$;

drop trigger if exists sales_orders_check_marketplace on public.sales_orders;
create trigger sales_orders_check_marketplace
  before insert or update of marketplace_id on public.sales_orders
  for each row execute function public.documents_check_marketplace();

drop trigger if exists invoices_check_marketplace on public.invoices;
create trigger invoices_check_marketplace
  before insert or update of marketplace_id on public.invoices
  for each row execute function public.documents_check_marketplace();

revoke execute on function public.documents_check_marketplace() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- What a channel has actually done
--
-- Definer, and scoped to the organization rather than to what the caller can
-- see — the same reasoning product_stock_summary follows. Orders are visible
-- per owner, so an invoker function would tell a rep their channel had turned
-- over £4k when it had turned over £40k, which is worse than telling them
-- nothing.
--
-- Cancelled orders and void invoices are left out. They are not money anybody
-- expects, which is the rule the lists already follow.
-- -----------------------------------------------------------------------------
create or replace function public.marketplace_sales(p_marketplace_id uuid)
returns table (
  currency       text,
  order_count    integer,
  order_value    numeric,
  invoice_count  integer,
  invoiced       numeric,
  collected      numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with orders as (
    select o.currency, count(*)::int as n, coalesce(sum(o.total_value), 0) as value
    from (
      select
        s.currency,
        coalesce((select sum(l.line_total) from public.sales_order_lines l
                  where l.sales_order_id = s.id), 0) + s.shipping_charge as total_value
      from public.sales_orders s
      where s.marketplace_id = p_marketplace_id
        and s.organization_id = public.current_org_id()
        and s.deleted_at is null
        and s.status <> 'cancelled'
    ) o
    group by o.currency
  ),
  billed as (
    select i.currency, count(*)::int as n,
           coalesce(sum(i.total), 0) as total,
           coalesce(sum(i.amount_paid), 0) as paid
    from public.invoices i
    where i.marketplace_id = p_marketplace_id
      and i.organization_id = public.current_org_id()
      and i.status <> 'void'
    group by i.currency
  )
  /*
   * Full join on currency, because a channel can have orders in one and
   * invoices in another and neither list is a subset of the other. One row per
   * currency rather than one total: adding USD to CAD would produce a number
   * that means nothing, which is the rule the money components already hold.
   */
  select
    coalesce(orders.currency, billed.currency),
    coalesce(orders.n, 0),
    coalesce(orders.value, 0),
    coalesce(billed.n, 0),
    coalesce(billed.total, 0),
    coalesce(billed.paid, 0)
  from orders
  full join billed on billed.currency = orders.currency
  order by 1;
$$;

comment on function public.marketplace_sales(uuid) is
  'What has been sold through one channel, per currency. Cancelled orders and void invoices are left out — they are not money anybody expects.';

revoke execute on function public.marketplace_sales(uuid) from public, anon;
grant execute on function public.marketplace_sales(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Converting an order carries the channel with it
--
-- Recreated from the live definition with two changes: the channel comes along,
-- and issue_date stops being current_date. That second one is the defect
-- 20260241000000 fixed on a deal's close date and 20260242000000 fixed on a
-- raised invoice — this function raises invoices too and was missed.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.convert_sales_order_to_invoice(p_sales_order_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org      uuid := public.current_org_id();
  v_actor    uuid := public.current_app_user_id();
  v_order    sales_orders%rowtype;
  v_existing uuid;
  v_invoice  uuid;
  v_subtotal numeric := 0;
  v_paid     numeric := 0;
  v_total    numeric := 0;
  v_owner    text;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow invoicing';
  end if;

  select * into v_order
  from public.sales_orders
  where id = p_sales_order_id
    and organization_id = v_org
    and deleted_at is null;

  if v_order.id is null or not public.can_see_owned(v_order.owner_id) then
    raise exception 'Sales order not found';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'Cannot invoice a cancelled order';
  end if;
  if v_order.status in ('draft', 'reserved') then
    raise exception 'Confirm the order before invoicing';
  end if;

  select id into v_existing from public.invoices where sales_order_id = p_sales_order_id;
  if v_existing is not null then
    return v_existing;
  end if;

  select coalesce(sum(line_total), 0) into v_subtotal
  from public.sales_order_lines where sales_order_id = p_sales_order_id;

  select coalesce(sum(amount), 0) into v_paid
  from public.sales_order_payments where sales_order_id = p_sales_order_id;

  v_total := round(v_subtotal + v_order.shipping_charge, 2);

  select coalesce(name, email) into v_owner from public.users where id = v_order.owner_id;

  begin
    insert into public.invoices (
      organization_id, number, sales_order_id, company_id, contact_id, owner_id, owner_name,
      status, currency, issue_date, subtotal, shipping_charge, total, amount_paid,
      payment_terms, notes, terms, marketplace_id, created_by
    )
    values (
      v_org,
      public.next_document_number(v_org, 'INV', null),
      p_sales_order_id,
      v_order.company_id,
      v_order.contact_id,
      v_order.owner_id,
      v_owner,
      public.invoice_status_for(v_total, v_paid, 'draft'),
      v_order.currency,
      -- Was current_date: the server's today rather than this organization's.
      -- The same defect 20260241000000 fixed on a deal's close date, missed
      -- here because this function was not touched by 20260242000000.
      public.org_today(v_org),
      v_subtotal,
      v_order.shipping_charge,
      v_total,
      v_paid,
      v_order.payment_terms,
      v_order.notes,
      v_order.terms,
      -- The channel comes with the order. An invoice raised from one sold
      -- through a marketplace was sold through that marketplace.
      v_order.marketplace_id,
      v_actor
    )
    returning id into v_invoice;
  exception when unique_violation then
    -- Somebody else converted it while we were counting. Their invoice is as
    -- good as ours would have been.
    select id into v_existing from public.invoices where sales_order_id = p_sales_order_id;
    if v_existing is not null then
      return v_existing;
    end if;
    raise;
  end;

  -- The lines, as text. A product renamed tomorrow does not rewrite what this
  -- document said today.
  insert into public.invoice_lines (
    organization_id, invoice_id, product_id, name, sku, notes,
    quantity, unit_price, unit_cost, discount, line_total, position
  )
  select
    v_org,
    v_invoice,
    l.product_id,
    coalesce(nullif(btrim(p.name), ''), nullif(btrim(l.description), ''), 'Item'),
    p.sku,
    l.notes,
    l.quantity,
    l.unit_price,
    l.unit_cost,
    l.discount,
    l.line_total,
    l.position
  from public.sales_order_lines l
  left join public.products p on p.id = l.product_id
  where l.sales_order_id = p_sales_order_id
  order by l.position, l.created_at;

  /*
   * Deposits taken on the order become the invoice's payments, so the balance
   * carries across. These go through the ledger trigger like any other payment,
   * which recomputes amount_paid as each lands — it converges on the same total
   * set above, and keeping one door onto amount_paid matters more than saving
   * the writes.
   *
   * Inserted largest first, which puts every deposit ahead of every reversal.
   * The trigger refuses a row that would take the running net below zero, and a
   * reversal copied ahead of the deposit it reverses would do exactly that —
   * possible here because paid_at can be backdated by hand.
   */
  insert into public.invoice_payments (
    organization_id, invoice_id, amount, method, note, paid_at, created_by
  )
  select
    v_org, v_invoice, pay.amount, pay.method,
    coalesce(pay.note, 'Deposit on ' || v_order.number),
    pay.paid_at, pay.created_by
  from public.sales_order_payments pay
  where pay.sales_order_id = p_sales_order_id
  order by pay.amount desc, pay.paid_at;

  return v_invoice;
end;
$function$;
