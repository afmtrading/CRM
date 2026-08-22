-- =============================================================================
-- An invoice you can raise without inventing a sales order
--
-- Two gaps found the same way: by trying to raise an invoice on its own.
--
--   1. Customer & Shipping was read on an invoice, on the reasoning that the
--      customer is a snapshot carried from the order. True of an invoice that
--      came from one, and false of an invoice raised on its own — there is no
--      order to carry anything from, so the card could not be filled in at all
--      and the only way to name a customer was to go and create an order.
--
--   2. The lines could be added and removed but not changed, and an invoice
--      line kept the *discount* without the rate that produced it. A rate is
--      how somebody said it ("10% off"); a discount is what it came to. Keep
--      only the second and the line cannot be edited without inventing the
--      first.
--
-- Both are the same shape of fix: give an invoice the columns a sales order
-- already has, with the same names and the same rules, so the two documents
-- stop being different kinds of thing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Where the goods go
--
-- The same five columns sales_orders carries, named identically. An invoice
-- raised from an order still shows the order's — that is the page's business,
-- not this file's — and these are for the invoice that has no order behind it.
-- -----------------------------------------------------------------------------

alter table public.invoices
  add column if not exists ship_to_company_id uuid references companies (id) on delete set null,
  add column if not exists ship_to_contact_id uuid references contacts (id) on delete set null,
  add column if not exists shipping_address text,
  add column if not exists shipping_method text,
  add column if not exists shipping_responsibility text;

comment on column public.invoices.shipping_responsibility is
  'Who moves the goods. Set directly on an invoice raised on its own; carried from the order otherwise.';

-- -----------------------------------------------------------------------------
-- How a line was priced, not just what it came to
--
-- `discount` is derived and stays derived. These two are the answer somebody
-- actually gave, which is what an editable line needs — without them, opening a
-- discounted line for editing shows an empty discount box, and saving it
-- silently prices the line back up.
-- -----------------------------------------------------------------------------

alter table public.invoice_lines
  add column if not exists unit text,
  add column if not exists revised_rate_type public.revised_rate_type,
  add column if not exists revised_rate numeric(14, 2);

do $$
begin
  -- The same both-or-neither rule sales_order_lines_rate_pair states.
  if not exists (select 1 from pg_constraint where conname = 'invoice_lines_rate_pair') then
    alter table public.invoice_lines
      add constraint invoice_lines_rate_pair
      check ((revised_rate_type is null) = (revised_rate is null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'invoice_lines_revised_rate_check') then
    alter table public.invoice_lines
      add constraint invoice_lines_revised_rate_check check (revised_rate >= 0);
  end if;
end
$$;

/*
 * What the existing lines were discounted by.
 *
 * Recovered rather than guessed. `sales_line_discount` for a fixed rate is
 * quantity × rate, so a stored discount of D over Q units came from a rate of
 * D/Q — exact, and it reproduces the same discount when the line is next
 * priced. Nothing here recomputes `discount` or `line_total`: the money on
 * every existing invoice is untouched, and only the rate that explains it is
 * filled in.
 *
 * Percent is not recoverable and is not invented. A line entered as "10% off"
 * comes back as the equivalent money off each unit, which prices identically
 * and is honest about what is known.
 */
update public.invoice_lines
set revised_rate_type = 'fixed',
    revised_rate = round(discount / quantity, 2)
where revised_rate_type is null
  and coalesce(discount, 0) > 0
  and coalesce(quantity, 0) > 0
  -- Only where it round-trips to the cent. A line that would come back a penny
  -- different keeps no rate at all rather than a rate that quietly restates it.
  and public.sales_line_discount(quantity, unit_price, 'fixed', round(discount / quantity, 2))
      = discount;

-- -----------------------------------------------------------------------------
-- Adding a line, now carrying the unit and the rate
--
-- Dropped and recreated rather than replaced. A new parameter is a new
-- signature, and `create or replace` obliges by leaving the old function
-- standing beside the new one — after which every call is "function is not
-- unique". The SQL suite caught exactly that.
-- -----------------------------------------------------------------------------

drop function if exists public.add_invoice_line(
  uuid, uuid, text, numeric, numeric, numeric, public.revised_rate_type, numeric, text
);

CREATE OR REPLACE FUNCTION public.add_invoice_line(
  p_invoice_id uuid,
  p_product_id uuid DEFAULT NULL::uuid,
  p_name text DEFAULT NULL::text,
  p_quantity numeric DEFAULT 1,
  p_unit_price numeric DEFAULT 0,
  p_unit_cost numeric DEFAULT 0,
  p_rate_type revised_rate_type DEFAULT NULL::revised_rate_type,
  p_rate numeric DEFAULT NULL::numeric,
  p_notes text DEFAULT NULL::text,
  p_unit text DEFAULT NULL::text
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    organization_id, invoice_id, product_id, name, sku, notes, unit,
    quantity, unit_price, unit_cost, revised_rate_type, revised_rate,
    discount, line_total, position
  )
  values (
    v_org, p_invoice_id, p_product_id, v_name, v_product.sku, nullif(btrim(p_notes), ''),
    coalesce(nullif(btrim(p_unit), ''), v_product.unit),
    p_quantity, p_unit_price,
    coalesce(nullif(p_unit_cost, 0), v_product.unit_cost, 0),
    p_rate_type, p_rate,
    v_discount,
    round(p_quantity * p_unit_price, 2) - v_discount,
    v_position
  )
  returning id into v_id;

  return v_id;
end;
$function$;

-- -----------------------------------------------------------------------------
-- And changing one
--
-- New. The lines could be added and removed and not edited, which on a document
-- somebody is building from scratch means retyping the whole line to fix a
-- quantity.
--
-- A definer function rather than an update policy, deliberately: invoice_lines
-- grants SELECT and nothing else, and every write goes through a function that
-- calls assert_invoice_editable first. That is what keeps a sent invoice's
-- lines frozen, and adding an editable path around it would undo the rule this
-- table exists to hold.
-- -----------------------------------------------------------------------------

create or replace function public.update_invoice_line(
  p_line_id    uuid,
  p_product_id uuid    default null,
  p_name       text    default null,
  p_quantity   numeric default 1,
  p_unit_price numeric default 0,
  p_unit_cost  numeric default 0,
  p_rate_type  public.revised_rate_type default null,
  p_rate       numeric default null,
  p_notes      text    default null,
  p_unit       text    default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_org      uuid := public.current_org_id();
  v_invoice  uuid;
  v_product  products%rowtype;
  v_name     text;
  v_discount numeric;
begin
  select invoice_id into v_invoice
  from public.invoice_lines
  where id = p_line_id and organization_id = v_org;

  if v_invoice is null then
    raise exception 'Line not found';
  end if;

  perform public.assert_invoice_editable(v_invoice);

  if p_product_id is not null then
    select * into v_product
    from public.products where id = p_product_id and organization_id = v_org;

    if v_product.id is null then
      raise exception 'Product not found';
    end if;
  end if;

  v_name := coalesce(nullif(btrim(v_product.name), ''), nullif(btrim(p_name), ''));
  if v_name is null then
    raise exception 'A line needs a product or a description';
  end if;

  v_discount := public.sales_line_discount(p_quantity, p_unit_price, p_rate_type, p_rate);

  update public.invoice_lines
  set product_id        = p_product_id,
      name              = v_name,
      sku               = v_product.sku,
      notes             = nullif(btrim(p_notes), ''),
      unit              = coalesce(nullif(btrim(p_unit), ''), v_product.unit),
      quantity          = p_quantity,
      unit_price        = p_unit_price,
      unit_cost         = coalesce(nullif(p_unit_cost, 0), v_product.unit_cost, 0),
      revised_rate_type = p_rate_type,
      revised_rate      = p_rate,
      discount          = v_discount,
      line_total        = round(p_quantity * p_unit_price, 2) - v_discount
  where id = p_line_id;
end;
$function$;

comment on function public.update_invoice_line(uuid, uuid, text, numeric, numeric, numeric, public.revised_rate_type, numeric, text, text) is
  'Changes one line of an editable invoice. Refuses a sent or converted one through assert_invoice_editable.';

revoke all on function public.update_invoice_line(uuid, uuid, text, numeric, numeric, numeric, public.revised_rate_type, numeric, text, text) from public, anon;
grant execute on function public.update_invoice_line(uuid, uuid, text, numeric, numeric, numeric, public.revised_rate_type, numeric, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- The conversion carries the unit and the rate across too
--
-- Recreated from the live definition rather than retyped from memory — the
-- lesson 20260247000000 wrote down. Only the line insert changes: three more
-- columns, so an invoice raised from an order shows the same "10% off" the
-- order showed rather than a bare figure.
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
      payment_terms, notes, terms, marketplace_id, created_by,
      ship_to_company_id, ship_to_contact_id, shipping_address,
      shipping_method, shipping_responsibility
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
      v_order.marketplace_id,
      v_actor,
      -- Copied rather than read through the order every time it is printed:
      -- an invoice is what the customer received, and the order's address
      -- changing next month must not rewrite it.
      v_order.ship_to_company_id,
      v_order.ship_to_contact_id,
      v_order.shipping_address,
      v_order.shipping_method,
      v_order.shipping_responsibility
    )
    returning id into v_invoice;
  exception when unique_violation then
    select id into v_existing from public.invoices where sales_order_id = p_sales_order_id;
    if v_existing is not null then
      return v_existing;
    end if;
    raise;
  end;

  insert into public.invoice_lines (
    organization_id, invoice_id, product_id, name, sku, notes, unit,
    quantity, unit_price, unit_cost, revised_rate_type, revised_rate,
    discount, line_total, position
  )
  select
    v_org,
    v_invoice,
    l.product_id,
    coalesce(nullif(btrim(p.name), ''), nullif(btrim(l.description), ''), 'Item'),
    p.sku,
    l.notes,
    coalesce(l.unit, p.unit),
    l.quantity,
    l.unit_price,
    l.unit_cost,
    l.revised_rate_type,
    l.revised_rate,
    l.discount,
    l.line_total,
    l.position
  from public.sales_order_lines l
  left join public.products p on p.id = l.product_id
  where l.sales_order_id = p_sales_order_id
  order by l.position, l.created_at;

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

  update public.sales_orders
  set status = 'fulfilled', updated_by = v_actor
  where id = p_sales_order_id;

  return v_invoice;
end;
$function$;
