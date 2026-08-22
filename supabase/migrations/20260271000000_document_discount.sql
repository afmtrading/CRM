-- =============================================================================
-- A discount on the whole document, and a shipping charge you can reach
--
-- Two gaps on the same card. The Summary printed "Shipping $0.00" with no
-- field anywhere that set it — the column and the header action have always
-- taken one, and the form simply never asked, which is the deposit note's
-- defect again. That half needs no migration.
--
-- This file is the other half: money off the whole order rather than off a
-- line. A desk that agrees "5% off the job" had to spread it across every line
-- by hand and hope the arithmetic came out, which is a discount the document
-- cannot state and the next person cannot verify.
--
-- Modelled on the line's revision, deliberately: the same enum, the same
-- both-or-neither pair, the same clamp at zero. One idea, stated twice, rather
-- than two ideas that behave almost alike.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The pair, on both documents
--
-- Nullable rather than defaulted to zero: no discount and a discount of zero
-- read the same on paper but are different statements, and only one of them
-- should print a Discount row.
-- -----------------------------------------------------------------------------

alter table public.sales_orders
  add column if not exists discount_type public.revised_rate_type,
  add column if not exists discount_rate numeric(14, 2);

alter table public.invoices
  add column if not exists discount_type public.revised_rate_type,
  add column if not exists discount_rate numeric(14, 2);

do $$
begin
  -- Half a pair is not a discount. The same rule sales_order_lines_rate_pair
  -- states about a line, for the same reason: a kind with no rate applies
  -- nothing, and a rate with no kind cannot be applied.
  if not exists (select 1 from pg_constraint where conname = 'sales_orders_discount_pair') then
    alter table public.sales_orders
      add constraint sales_orders_discount_pair
      check ((discount_type is null) = (discount_rate is null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'sales_orders_discount_rate_check') then
    alter table public.sales_orders
      add constraint sales_orders_discount_rate_check check (discount_rate >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'invoices_discount_pair') then
    alter table public.invoices
      add constraint invoices_discount_pair
      check ((discount_type is null) = (discount_rate is null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'invoices_discount_rate_check') then
    alter table public.invoices
      add constraint invoices_discount_rate_check check (discount_rate >= 0);
  end if;
end $$;

comment on column public.sales_orders.discount_rate is
  'Money off the whole order, as a percent or an amount. Null means there is none, which is not the same as zero.';
comment on column public.invoices.discount_rate is
  'Money off the whole invoice. Carried from the order when there was one.';

-- -----------------------------------------------------------------------------
-- What it comes to
--
-- The twin of sales_line_discount, one level up, and clamped at both ends for
-- the same reasons. Never below zero, because a discount is money off rather
-- than a surcharge. Never above the subtotal, because 150% off an order is a
-- free order rather than money owed back to the customer.
--
-- lib/sales carries the same formula so a form can show the number before it
-- saves it. Where the two disagree this one wins and the screen is wrong for a
-- moment, which is the bargain the rest of this app already makes.
-- -----------------------------------------------------------------------------

create or replace function public.document_discount(
  p_subtotal  numeric,
  p_rate_type public.revised_rate_type,
  p_rate      numeric
) returns numeric
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select round(
    least(
      greatest(coalesce(p_subtotal, 0), 0),
      greatest(0, case
        when p_rate_type is null or p_rate is null then 0
        when p_rate_type = 'percent' then coalesce(p_subtotal, 0) * p_rate / 100
        when p_rate_type = 'fixed'   then p_rate
      end)
    ),
    2
  );
$$;

comment on function public.document_discount(numeric, public.revised_rate_type, numeric) is
  'Money off a document subtotal. Clamped to [0, subtotal]: a discount is never a surcharge and never a refund.';

-- -----------------------------------------------------------------------------
-- Every place a total is worked out
--
-- Three of them, and all three have to agree — a total is stored on an invoice
-- and drives its status and its balance, so one site left behind is an invoice
-- that says it is paid when it is not.
-- -----------------------------------------------------------------------------

/* When a draft invoice's lines change. */
create or replace function public.invoice_lines_sync_total()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice  uuid := coalesce(new.invoice_id, old.invoice_id);
  v_subtotal numeric;
  v_total    numeric;
begin
  select coalesce(sum(line_total), 0) into v_subtotal
  from public.invoice_lines where invoice_id = v_invoice;

  update public.invoices
  set subtotal = v_subtotal,
      total = round(
        v_subtotal
          - public.document_discount(v_subtotal, discount_type, discount_rate)
          + shipping_charge,
        2
      ),
      status = public.invoice_status_for(
        round(
          v_subtotal
            - public.document_discount(v_subtotal, discount_type, discount_rate)
            + shipping_charge,
          2
        ),
        amount_paid,
        status
      )
  where id = v_invoice
  returning total into v_total;

  return null;
end;
$$;

/* When the shipping charge or the discount changes. */
create or replace function public.invoices_sync_total()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.shipping_charge is distinct from old.shipping_charge
     or new.discount_type is distinct from old.discount_type
     or new.discount_rate is distinct from old.discount_rate
  then
    new.total := round(
      new.subtotal
        - public.document_discount(new.subtotal, new.discount_type, new.discount_rate)
        + new.shipping_charge,
      2
    );
    new.status := public.invoice_status_for(new.total, new.amount_paid, new.status);
  end if;
  return new;
end;
$$;

/*
 * The trigger has to watch the new columns too. `update of` is a filter, not a
 * hint: left as it was, a discount saved on an invoice would change the number
 * on screen and leave the stored total alone.
 */
drop trigger if exists invoices_total on public.invoices;
create trigger invoices_total
  before update of shipping_charge, discount_type, discount_rate on public.invoices
  for each row execute function public.invoices_sync_total();

-- -----------------------------------------------------------------------------
-- And the conversion carries it across
--
-- Recreated from the live definition rather than retyped from memory — the
-- lesson 20260247000000 wrote down about functions losing their security mode
-- or a check nobody noticed was in them. Only the discount is new: two columns
-- on the insert, and the total computed through the same helper.
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

  -- The order's own discount, off the order's own subtotal. Worked out here
  -- rather than copied, so an invoice cannot inherit a figure computed against
  -- a subtotal that has since changed.
  v_total := round(
    v_subtotal
      - public.document_discount(v_subtotal, v_order.discount_type, v_order.discount_rate)
      + v_order.shipping_charge,
    2
  );

  select coalesce(name, email) into v_owner from public.users where id = v_order.owner_id;

  begin
    insert into public.invoices (
      organization_id, number, sales_order_id, company_id, contact_id, owner_id, owner_name,
      status, currency, issue_date, subtotal, discount_type, discount_rate,
      shipping_charge, total, amount_paid,
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
      v_order.discount_type,
      v_order.discount_rate,
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

  /*
   * And the order says so. This is the only place that sets the status, which
   * is what makes Invoiced mean an invoice exists rather than mean somebody
   * pressed a button.
   */
  update public.sales_orders
  set status = 'fulfilled', updated_by = v_actor
  where id = p_sales_order_id;

  return v_invoice;
end;
$function$;
