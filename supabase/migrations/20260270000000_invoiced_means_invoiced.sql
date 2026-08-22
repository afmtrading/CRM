-- =============================================================================
-- Invoiced means an invoice exists
--
-- The status was called Fulfilled and could be set by hand from Confirmed,
-- which was honest while it meant "delivered and done" — a fact only a person
-- knows. Renamed to Invoiced, a hand-set value is a claim the database can
-- check and was not checking: somebody could mark an order Invoiced with no
-- invoice anywhere, and the list would say billed about an order nobody had
-- billed.
--
-- So the status stops being something anybody sets. Raising the invoice sets
-- it, and a trigger refuses it in every other circumstance.
--
-- The enum member is still `fulfilled`. It is referenced by stored rows, by
-- can_invoice's SQL twin and by this trigger; renaming it to match the label
-- would be a migration that buys a word.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The conversion sets it
--
-- Recreated from the live definition with the update appended, rather than
-- rebuilt from what this file remembers of it — the lesson 20260247000000
-- wrote down about retyped functions losing their security mode or a check
-- nobody noticed was in them.
--
-- The update comes *after* the insert, which the trigger below depends on: by
-- then the invoice exists, so the order is allowed to say so.
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

-- -----------------------------------------------------------------------------
-- And nothing else may
--
-- The application stops offering the transition, which is enough for the
-- screen and not enough for the database: the session lives in a browser and
-- PostgREST takes a status like any other column.
--
-- Written as "there is an invoice" rather than "the caller is the conversion
-- function", so an administrator fixing something by hand is refused for the
-- same reason and allowed for the same reason. A rule that only trusts one
-- caller is a rule that breaks the moment there are two.
-- -----------------------------------------------------------------------------

create or replace function public.sales_orders_guard_invoiced()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'fulfilled'
     and not exists (select 1 from public.invoices where sales_order_id = new.id)
  then
    raise exception 'An order is Invoiced once an invoice exists for it. Use Convert to invoice.';
  end if;

  return new;
end;
$$;

comment on function public.sales_orders_guard_invoiced() is
  'Refuses the Invoiced status on an order with no invoice. The status is set by convert_sales_order_to_invoice and by nothing else.';

drop trigger if exists sales_orders_guard_invoiced on public.sales_orders;
create trigger sales_orders_guard_invoiced
  before update on public.sales_orders
  for each row execute function public.sales_orders_guard_invoiced();

-- -----------------------------------------------------------------------------
-- The one row that disagrees
--
-- An order carrying an invoice and still reading Confirmed — invoiced in fact
-- and not in status, which is this gap seen from the other side. Written down
-- in docs/DATA_CHANGES.md with the check that nothing is marked Invoiced
-- *without* an invoice, so this promotes and never demotes.
--
-- Cancelled is left alone: an order somebody called off is not made Invoiced
-- by an invoice raised before they did.
-- -----------------------------------------------------------------------------

update public.sales_orders o
set status = 'fulfilled'
where o.status <> 'cancelled'
  and o.status <> 'fulfilled'
  and exists (select 1 from public.invoices i where i.sales_order_id = o.id);
