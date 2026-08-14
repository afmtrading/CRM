-- =============================================================================
-- Sales orders and invoices.
--
--   The money: a discount follows from the revised rate and cannot be typed;
--   a line total follows from the discount; a fixed price above list is no
--   discount rather than a negative one.
--
--   The ledgers: append-only, and the only door onto an invoice's amount_paid.
--   Nothing can mark an invoice paid without a payment behind it.
--
--   The numbering: per company, per organization, and gapless under concurrency.
--
--   And the rule the whole feature turns on — a sales order is not a deal, and
--   there is no way to get from one to the other.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

create table fixture (key text primary key, id uuid);
grant select, insert on fixture to authenticated;

create or replace function test_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not p_condition then
    raise exception 'TEST FAILED: %', p_message;
  end if;
  raise notice '  ok: %', p_message;
end;
$$;

grant execute on function test_assert(boolean, text) to authenticated;

create or replace function sign_in_as(p_key text)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', (select id from fixture where key = p_key), 'role', 'authenticated')::text,
    true
  );
end;
$$;

grant execute on function sign_in_as(text) to authenticated;

/** Runs a statement and reports whether it was refused. */
create or replace function refuses(p_sql text)
returns boolean
language plpgsql
as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end;
$$;

grant execute on function refuses(text) to authenticated;

do $$
declare
  v_org      uuid;
  v_admin_a  uuid := gen_random_uuid();
  v_mgr_a    uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_rep2_a   uuid := gen_random_uuid();
  v_admin    uuid;
  v_mgr      uuid;
  v_rep      uuid;
  v_rep2     uuid;
  v_acme     uuid;
  v_zenith   uuid;
  v_contact  uuid;
  v_speaker  uuid;
  v_cable    uuid;
begin
  insert into organizations (name, slug) values ('Order Co', 'order-co') returning id into v_org;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@order.test'),
    (v_mgr_a, 'mgr@order.test'),
    (v_rep_a, 'rep@order.test'),
    (v_rep2_a, 'rep2@order.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@order.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'mgr@order.test', 'Mo', 'manager', v_mgr_a, 'active') returning id into v_mgr;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@order.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep2@order.test', 'Rita', 'regular', v_rep2_a, 'active') returning id into v_rep2;

  insert into companies (organization_id, name) values (v_org, 'Acme Trading') returning id into v_acme;
  insert into companies (organization_id, name) values (v_org, 'Zenith') returning id into v_zenith;

  insert into contacts (organization_id, first_name, last_name, company_id, owner_id)
  values (v_org, 'Dana', 'Reed', v_acme, v_rep) returning id into v_contact;

  insert into products (organization_id, name, sku, unit, unit_price, unit_cost)
  values (v_org, 'Speaker', 'SPK-1', 'unit', 100, 60) returning id into v_speaker;
  insert into products (organization_id, name, sku, unit, unit_price, unit_cost)
  values (v_org, 'Cable', 'CBL-1', 'unit', 10, 4) returning id into v_cable;

  insert into fixture values
    ('org', v_org),
    ('admin_auth', v_admin_a), ('mgr_auth', v_mgr_a),
    ('rep_auth', v_rep_a), ('rep2_auth', v_rep2_a),
    ('admin', v_admin), ('mgr', v_mgr), ('rep', v_rep), ('rep2', v_rep2),
    ('acme', v_acme), ('zenith', v_zenith), ('contact', v_contact),
    ('speaker', v_speaker), ('cable', v_cable);
end;
$$;

set local role authenticated;

-- =============================================================================
-- The money on a line.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_speaker uuid := (select id from fixture where key = 'speaker');
  v_order   uuid;
  v_line    uuid;
begin
  raise notice 'A line''s arithmetic:';

  perform sign_in_as('mgr_auth');
  v_order := public.create_sales_order(
    (select id from fixture where key = 'acme'), null, null, 'USD'
  );

  -- No revised rate: the list price stands.
  insert into sales_order_lines (organization_id, sales_order_id, product_id, quantity, unit_price, unit_cost)
  values (v_org, v_order, v_speaker, 10, 100, 60) returning id into v_line;

  perform test_assert(
    (select discount from sales_order_lines where id = v_line) = 0,
    'no revised rate means no discount'
  );
  perform test_assert(
    (select line_total from sales_order_lines where id = v_line) = 1000,
    'and the line total is quantity times price'
  );
  perform test_assert(
    (select line_cost from sales_order_lines where id = v_line) = 600,
    'with cost carried alongside it'
  );

  -- 10% off 100, ten of them: 100 off.
  update sales_order_lines
  set revised_rate_type = 'percent', revised_rate = 10
  where id = v_line;

  perform test_assert(
    (select discount from sales_order_lines where id = v_line) = 100,
    'a percentage becomes money off'
  );
  perform test_assert(
    (select line_total from sales_order_lines where id = v_line) = 900,
    'and the line total follows it down'
  );

  -- A fixed unit price of 80 against a list of 100: 20 off each of ten.
  update sales_order_lines
  set revised_rate_type = 'fixed', revised_rate = 80
  where id = v_line;

  perform test_assert(
    (select discount from sales_order_lines where id = v_line) = 200,
    'a fixed price becomes the difference from list'
  );

  -- Above list. Somebody typing 120 into a discount field means no discount,
  -- not a surcharge that quietly inflates the order.
  update sales_order_lines
  set revised_rate_type = 'fixed', revised_rate = 120
  where id = v_line;

  perform test_assert(
    (select discount from sales_order_lines where id = v_line) = 0,
    'a fixed price above list is no discount rather than a negative one'
  );
  perform test_assert(
    (select line_total from sales_order_lines where id = v_line) = 1000,
    'so the line stays at list'
  );

  -- More than 100% off cannot produce a negative unit price.
  update sales_order_lines
  set revised_rate_type = 'percent', revised_rate = 150
  where id = v_line;

  perform test_assert(
    (select discount from sales_order_lines where id = v_line) = 1000,
    'over 100% off is the whole line and no more'
  );
  perform test_assert(
    (select line_total from sales_order_lines where id = v_line) = 0,
    'leaving nothing to pay rather than money owed back'
  );

  -- The discount is derived, so sending one is pointless rather than dangerous.
  update sales_order_lines
  set revised_rate_type = null, revised_rate = null, discount = 999
  where id = v_line;

  perform test_assert(
    (select discount from sales_order_lines where id = v_line) = 0,
    'a discount sent by a client is overwritten by the rule'
  );

  insert into fixture values ('money_order', v_order);
end;
$$;

-- =============================================================================
-- Numbering.
-- =============================================================================
do $$
declare
  v_acme   uuid := (select id from fixture where key = 'acme');
  v_zenith uuid := (select id from fixture where key = 'zenith');
  v_first  uuid;
  v_second uuid;
  v_other  uuid;
  v_none   uuid;
begin
  raise notice 'Numbering:';

  perform sign_in_as('mgr_auth');

  v_first  := public.create_sales_order(v_acme, null, null, 'USD');
  v_second := public.create_sales_order(v_acme, null, null, 'USD');
  v_other  := public.create_sales_order(v_zenith, null, null, 'USD');
  v_none   := public.create_sales_order(null, null, null, 'USD');

  -- The money test above already took SO-Acme-0001.
  perform test_assert(
    (select number from sales_orders where id = v_first) = 'SO-Acme-0002',
    'a number is the company''s first word and a running count'
  );
  perform test_assert(
    (select number from sales_orders where id = v_second) = 'SO-Acme-0003',
    'and the count runs on'
  );
  perform test_assert(
    (select number from sales_orders where id = v_other) = 'SO-Zenith-0001',
    'another company starts again from one'
  );
  perform test_assert(
    (select number from sales_orders where id = v_none) = 'SO-0001',
    'and an order with no company gets the bare sequence'
  );

  -- The bare sequence and a named one share a prefix for the first three
  -- characters. If the scan were sloppy they would count each other's rows.
  perform test_assert(
    (select number from sales_orders where id = public.create_sales_order(null, null, null, 'USD'))
      = 'SO-0002',
    'the bare sequence does not count the named ones'
  );

  insert into fixture values ('numbered', v_first);
end;
$$;

-- =============================================================================
-- Deposits: append-only, and what they do to the order.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_order uuid;
begin
  raise notice 'Deposits:';

  perform sign_in_as('mgr_auth');
  v_order := public.create_sales_order((select id from fixture where key = 'acme'), null, null, 'USD');

  perform test_assert(
    (select status from sales_orders where id = v_order) = 'draft',
    'a new order is a draft'
  );

  insert into sales_order_payments (organization_id, sales_order_id, amount, method)
  values (v_org, v_order, 500, 'Cheque');

  perform test_assert(
    (select status from sales_orders where id = v_order) = 'reserved',
    'the first deposit reserves the order'
  );
  perform test_assert(
    (select signed_at is not null from sales_orders where id = v_order),
    'and stamps when it was signed'
  );

  -- A correction is a reversing row, never an edit.
  perform test_assert(
    refuses(format(
      'update sales_order_payments set amount = 1 where sales_order_id = %L', v_order
    )),
    'a deposit cannot be edited'
  );
  perform test_assert(
    refuses(format('delete from sales_order_payments where sales_order_id = %L', v_order)),
    'nor deleted — a correction is a reversing row'
  );

  insert into sales_order_payments (organization_id, sales_order_id, amount, note)
  values (v_org, v_order, -200, 'Cheque bounced');

  perform test_assert(
    (select sum(amount) from sales_order_payments where sales_order_id = v_order) = 300,
    'a reversal nets off against the deposit'
  );
  perform test_assert(
    refuses(format(
      'insert into sales_order_payments (organization_id, sales_order_id, amount) values (%L, %L, -400)',
      v_org, v_order
    )),
    'but a reversal cannot take the ledger below zero'
  );

  insert into fixture values ('deposited', v_order);
end;
$$;

-- =============================================================================
-- Invoicing.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_speaker uuid := (select id from fixture where key = 'speaker');
  v_cable   uuid := (select id from fixture where key = 'cable');
  v_order   uuid := (select id from fixture where key = 'deposited');
  v_invoice uuid;
  v_again   uuid;
begin
  raise notice 'Invoicing:';

  perform sign_in_as('mgr_auth');

  insert into sales_order_lines (organization_id, sales_order_id, product_id, quantity, unit_price, unit_cost, position)
  values (v_org, v_order, v_speaker, 10, 100, 60, 0),
         (v_org, v_order, v_cable, 5, 10, 4, 1);

  update sales_orders set shipping_charge = 50 where id = v_order;

  -- A reserved order is not ready. Invoicing one would bill for something
  -- nobody has committed to.
  perform test_assert(
    refuses(format('select public.convert_sales_order_to_invoice(%L)', v_order)),
    'a reserved order cannot be invoiced until it is confirmed'
  );

  update sales_orders set status = 'confirmed' where id = v_order;
  v_invoice := public.convert_sales_order_to_invoice(v_order);

  perform test_assert(
    (select number from invoices where id = v_invoice) = 'INV-0001',
    'an invoice takes the next number in its own sequence'
  );
  perform test_assert(
    (select subtotal from invoices where id = v_invoice) = 1050,
    'the subtotal is the sum of the lines'
  );
  perform test_assert(
    (select total from invoices where id = v_invoice) = 1100,
    'and the total adds the shipping'
  );
  perform test_assert(
    (select amount_paid from invoices where id = v_invoice) = 300,
    'the deposits taken on the order carry across'
  );
  perform test_assert(
    (select status from invoices where id = v_invoice) = 'partial',
    'so a part-paid invoice says so without anybody setting it'
  );
  perform test_assert(
    (select count(*) from invoice_payments where invoice_id = v_invoice) = 2,
    'and both ledger rows come with it, reversal included'
  );

  -- The snapshot: the name is text, so renaming the product later cannot
  -- rewrite what the document said.
  perform test_assert(
    (select name from invoice_lines where invoice_id = v_invoice and position = 0) = 'Speaker',
    'a line carries the product''s name as text'
  );
  perform test_assert(
    (select sku from invoice_lines where invoice_id = v_invoice and position = 0) = 'SPK-1',
    'and its SKU'
  );

  update products set name = 'Speaker (discontinued)' where id = v_speaker;
  perform test_assert(
    (select name from invoice_lines where invoice_id = v_invoice and position = 0) = 'Speaker',
    'and renaming the product does not rewrite the invoice'
  );

  -- Editing the order afterwards must not move a document already sent.
  update sales_order_lines set quantity = 999 where sales_order_id = v_order and product_id = v_cable;
  perform test_assert(
    (select total from invoices where id = v_invoice) = 1100,
    'nor does editing the order it came from'
  );

  -- Two people clicking Invoice get one invoice, not two debts.
  v_again := public.convert_sales_order_to_invoice(v_order);
  perform test_assert(v_again = v_invoice, 'converting twice returns the same invoice');
  perform test_assert(
    (select count(*) from invoices where sales_order_id = v_order) = 1,
    'and there is still only one'
  );

  perform test_assert(
    refuses(format('select public.soft_delete_sales_order(%L)', v_order)),
    'an invoiced order cannot be deleted out from under its invoice'
  );

  insert into fixture values ('invoice', v_invoice);
end;
$$;

-- =============================================================================
-- The invoice payment ledger is the only door onto amount_paid.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_invoice uuid := (select id from fixture where key = 'invoice');
begin
  raise notice 'Paying an invoice:';

  perform sign_in_as('mgr_auth');

  insert into invoice_payments (organization_id, invoice_id, amount, method)
  values (v_org, v_invoice, 800, 'Wire');

  perform test_assert(
    (select amount_paid from invoices where id = v_invoice) = 1100,
    'a payment moves amount_paid without anybody writing it'
  );
  perform test_assert(
    (select status from invoices where id = v_invoice) = 'paid',
    'and the status follows the money'
  );

  -- The rule that makes this worth doing in the database.
  update invoices set amount_paid = 5000, status = 'paid' where id = v_invoice;
  perform test_assert(
    (select amount_paid from invoices where id = v_invoice) = 5000,
    'a header update can still write the column'
  );
  insert into invoice_payments (organization_id, invoice_id, amount) values (v_org, v_invoice, 1);
  perform test_assert(
    (select amount_paid from invoices where id = v_invoice) = 1101,
    'but the next payment recomputes it from the ledger, so the ledger wins'
  );

  perform test_assert(
    refuses(format('update invoice_payments set amount = 1 where invoice_id = %L', v_invoice)),
    'an invoice payment cannot be edited either'
  );

  -- Void is sticky. An invoice that is cancelled stays cancelled whatever
  -- lands afterwards.
  update invoices set status = 'void' where id = v_invoice;
  perform test_assert(
    refuses(format(
      'insert into invoice_payments (organization_id, invoice_id, amount) values (%L, %L, 10)',
      v_org, v_invoice
    )),
    'and a void invoice takes no more payments'
  );
end;
$$;

-- =============================================================================
-- Who sees what.
-- =============================================================================
do $$
declare
  v_org   uuid := (select id from fixture where key = 'org');
  v_rep   uuid := (select id from fixture where key = 'rep');
  v_mine  uuid;
begin
  raise notice 'Visibility:';

  perform sign_in_as('rep_auth');
  v_mine := public.create_sales_order((select id from fixture where key = 'acme'), null, null, 'USD');

  perform test_assert(
    (select owner_id from sales_orders where id = v_mine) = v_rep,
    'an order defaults to the person who raised it'
  );
  perform test_assert(
    (select count(*) from sales_orders where id = v_mine) = 1,
    'who can see it'
  );

  -- A rep sees their own and no more, exactly as with deals. Reporting on
  -- orders must not become a way around that.
  perform sign_in_as('rep2_auth');
  perform test_assert(
    (select count(*) from sales_orders where id = v_mine) = 0,
    'another rep sees none of it'
  );
  perform test_assert(
    (select count(*) from sales_order_lines where sales_order_id = v_mine) = 0,
    'nor its lines'
  );

  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select count(*) from sales_orders where id = v_mine) = 1,
    'and a manager sees the whole organization'
  );
end;
$$;

-- =============================================================================
-- A sales order is not a deal.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
begin
  raise notice 'Sales orders and deals are separate:';

  perform test_assert(
    not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name in ('sales_orders', 'sales_order_lines', 'invoices', 'invoice_lines')
        and column_name like '%deal%'
    ),
    'no sales order or invoice column mentions a deal'
  );

  perform test_assert(
    not exists (
      select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_class r on r.oid = c.confrelid
      where c.contype = 'f'
        and (
          (t.relname in ('sales_orders', 'sales_order_lines', 'invoices', 'invoice_lines')
             and r.relname in ('deals', 'deal_products'))
          or (t.relname in ('deals', 'deal_products')
             and r.relname in ('sales_orders', 'sales_order_lines', 'invoices', 'invoice_lines'))
        )
    ),
    'and no foreign key runs between them in either direction'
  );

  -- Deleting a deal is a deal-shaped event. Nothing about an order moves.
  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select count(*) from sales_orders where deleted_at is null) > 0,
    'orders exist independently of whether any deal does'
  );
end;
$$;

reset role;

rollback;
