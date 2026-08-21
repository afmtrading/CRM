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

  -- $80 off a list of 100, ten of them: 800 off. A fixed rate is an amount
  -- taken off a unit, the same kind of thing a percentage is — it used to
  -- replace the unit price, which read wrong under a column called Discount.
  -- See 20260268000000.
  update sales_order_lines
  set revised_rate_type = 'fixed', revised_rate = 80
  where id = v_line;

  perform test_assert(
    (select discount from sales_order_lines where id = v_line) = 800,
    'a fixed rate is money off each unit'
  );
  perform test_assert(
    (select line_total from sales_order_lines where id = v_line) = 200,
    'and the line total follows it down'
  );

  -- More off than the unit is worth. Free, and no further: reading the excess
  -- as money owed back would turn a mistyped discount into a refund.
  update sales_order_lines
  set revised_rate_type = 'fixed', revised_rate = 120
  where id = v_line;

  perform test_assert(
    (select discount from sales_order_lines where id = v_line) = 1000,
    'more off than the unit is worth stops at the whole line'
  );
  perform test_assert(
    (select line_total from sales_order_lines where id = v_line) = 0,
    'leaving nothing to pay rather than money owed back'
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

-- =============================================================================
-- A signed order holds its stock.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_speaker uuid;
  v_loc     uuid;
  v_order   uuid;
  v_row     record;
begin
  raise notice 'Stock held by an order:';

  perform sign_in_as('admin_auth');

  -- Its own product. The speaker is already held by the confirmed order the
  -- invoicing test left behind, and a stock test that depends on what ran
  -- before it is a test that fails for the wrong reason later.
  insert into products (organization_id, name, sku, unit, unit_price, unit_cost)
  values (v_org, 'Amplifier', 'AMP-1', 'unit', 200, 120) returning id into v_speaker;

  select id into v_loc from stock_locations where organization_id = v_org limit 1;
  perform public.set_stock_level(v_speaker, v_loc, null, 100, 0, 'count', 'opening');

  perform sign_in_as('mgr_auth');
  select * into v_row from public.product_stock_summary(v_speaker);
  perform test_assert(v_row.on_hand = 100, 'a hundred on the shelf');
  perform test_assert(v_row.committed_orders = 0, 'and nothing held by an order yet');

  v_order := public.create_sales_order((select id from fixture where key = 'acme'), null, null, 'USD');
  insert into sales_order_lines (organization_id, sales_order_id, product_id, quantity, unit_price)
  values (v_org, v_order, v_speaker, 30, 100);

  -- A draft commits to nothing. That is what the status means, and stock is
  -- where it matters most: a quote somebody is still writing must not make the
  -- warehouse look emptier than it is.
  select * into v_row from public.product_stock_summary(v_speaker);
  perform test_assert(v_row.committed_orders = 0, 'a draft order holds nothing');
  perform test_assert(v_row.available = 100, 'so everything is still available');

  -- Signing it is the moment the stock is spoken for.
  insert into sales_order_payments (organization_id, sales_order_id, amount)
  values (v_org, v_order, 500);

  perform test_assert(
    (select status from sales_orders where id = v_order) = 'reserved',
    'the deposit signs the order'
  );

  select * into v_row from public.product_stock_summary(v_speaker);
  perform test_assert(v_row.committed_orders = 30, 'and now the order holds thirty');
  perform test_assert(v_row.available = 70, 'leaving seventy available');
  perform test_assert(v_row.on_hand = 100, 'without moving what is on the shelf');
  perform test_assert(v_row.reserved = 0, 'and without touching the by-hand reserve');

  -- Derived, not copied. Editing the order moves the number with it, which is
  -- the whole reason this is not a stored hold.
  update sales_order_lines set quantity = 45 where sales_order_id = v_order;
  select * into v_row from public.product_stock_summary(v_speaker);
  perform test_assert(v_row.committed_orders = 45, 'editing the line moves the hold');

  update sales_orders set status = 'confirmed' where id = v_order;
  select * into v_row from public.product_stock_summary(v_speaker);
  perform test_assert(v_row.committed_orders = 45, 'a confirmed order still holds it');

  -- Fulfilled means the goods have gone. Holding stock that is no longer in the
  -- building would double-count it against whatever movement records it leaving.
  update sales_orders set status = 'fulfilled' where id = v_order;
  select * into v_row from public.product_stock_summary(v_speaker);
  perform test_assert(v_row.committed_orders = 0, 'a fulfilled order holds nothing');

  update sales_orders set status = 'confirmed' where id = v_order;
  update sales_orders set status = 'cancelled' where id = v_order;
  select * into v_row from public.product_stock_summary(v_speaker);
  perform test_assert(v_row.committed_orders = 0, 'nor does a cancelled one');
  perform test_assert(v_row.available = 100, 'and the stock comes straight back');

  insert into fixture values ('stock_order', v_order), ('stock_loc', v_loc), ('amp', v_speaker);
end;
$$;

do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_speaker uuid := (select id from fixture where key = 'amp');
  v_stage   uuid;
  v_deal    uuid;
  v_order   uuid;
  v_row     record;
begin
  raise notice 'Deals and orders hold stock side by side:';

  perform sign_in_as('mgr_auth');

  v_order := public.create_sales_order((select id from fixture where key = 'acme'), null, null, 'USD');
  insert into sales_order_lines (organization_id, sales_order_id, product_id, quantity, unit_price)
  values (v_org, v_order, v_speaker, 20, 100);
  update sales_orders set status = 'confirmed' where id = v_order;

  select s.id into v_stage from stages s join pipelines p on p.id = s.pipeline_id
  where p.organization_id = v_org and s.outcome = 'open' order by s."order" limit 1;

  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Also wants speakers', v_stage, 1000, 'USD',
          (select id from fixture where key = 'mgr'))
  returning id into v_deal;

  insert into deal_products (organization_id, deal_id, product_id, quantity, unit_price, unit_cost)
  values (v_org, v_deal, v_speaker, 15, 100, 60);

  select * into v_row from public.product_stock_summary(v_speaker);
  perform test_assert(v_row.committed_deals = 15, 'the open deal holds fifteen');
  perform test_assert(v_row.committed_orders = 20, 'the signed order holds twenty');
  perform test_assert(v_row.committed = 35, 'and committed is the two of them together');
  perform test_assert(v_row.available = 65, 'so sixty-five is left');

  -- The catalogue view has to agree with the record view, or one of the two
  -- screens is lying and nobody can tell which.
  perform test_assert(
    (select committed_orders from public.product_stock_overview() where product_id = v_speaker) = 20,
    'the overview says the same as the record'
  );
  perform test_assert(
    (select available from public.product_stock_overview() where product_id = v_speaker) = 65,
    'and agrees on what is available'
  );

  -- Overselling stays visible rather than being clamped at zero.
  update sales_order_lines set quantity = 200 where sales_order_id = v_order;
  select * into v_row from public.product_stock_summary(v_speaker);
  perform test_assert(v_row.available = -115, 'promising more than exists shows as negative');

  perform test_assert(
    (select sum(quantity) from public.product_committed_orders(v_speaker)) = 200,
    'and the orders holding it can be named'
  );
end;
$$;

-- =============================================================================
-- An invoice raised on its own.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_amp     uuid := (select id from fixture where key = 'amp');
  v_invoice uuid;
  v_line    uuid;
  v_row     record;
begin
  raise notice 'An invoice with no order behind it:';

  perform sign_in_as('mgr_auth');

  v_invoice := public.create_invoice((select id from fixture where key = 'acme'), null, null, 'USD');

  perform test_assert(
    (select sales_order_id is null from invoices where id = v_invoice),
    'it stands on its own, with no order behind it'
  );
  perform test_assert(
    (select status from invoices where id = v_invoice) = 'draft',
    'and starts as a draft'
  );
  perform test_assert(
    (select number from invoices where id = v_invoice) ~ '^INV-\d+$',
    'taking the next number in the same sequence as a converted one'
  );

  -- The money rule is the one the sales order lines use: 10% off 200, five of
  -- them, is 100 off. Nothing sends a discount.
  v_line := public.add_invoice_line(v_invoice, v_amp, null, 5, 200, 0, 'percent', 10, null);

  perform test_assert(
    (select discount from invoice_lines where id = v_line) = 100,
    'a revised rate becomes money off, computed here rather than sent'
  );
  perform test_assert(
    (select line_total from invoice_lines where id = v_line) = 900,
    'and the line total follows it'
  );
  perform test_assert(
    (select name from invoice_lines where id = v_line) = 'Amplifier',
    'the product name is snapshotted onto the line'
  );

  -- Totals are stored, and stored is not the same as typed.
  perform test_assert(
    (select subtotal from invoices where id = v_invoice) = 900,
    'the invoice total follows its lines'
  );

  update invoices set shipping_charge = 50 where id = v_invoice;
  perform test_assert(
    (select total from invoices where id = v_invoice) = 950,
    'and shipping moves the total too'
  );

  perform public.remove_invoice_line(v_line);
  perform test_assert(
    (select subtotal from invoices where id = v_invoice) = 0,
    'removing the line takes the total back down'
  );

  -- A line still needs to be something.
  perform test_assert(
    refuses(format('select public.add_invoice_line(%L, null, null, 1, 10)', v_invoice)),
    'a line with neither a product nor a description is refused'
  );

  insert into fixture values ('standalone', v_invoice);
end;
$$;

-- =============================================================================
-- An issued invoice is frozen, whatever it came from.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_amp     uuid := (select id from fixture where key = 'amp');
  v_invoice uuid := (select id from fixture where key = 'standalone');
  v_from_so uuid := (select id from fixture where key = 'invoice');
begin
  raise notice 'What may still be written to:';

  perform sign_in_as('mgr_auth');

  perform public.add_invoice_line(v_invoice, v_amp, null, 2, 200, 0, null, null, null);
  update invoices set status = 'sent' where id = v_invoice;

  perform test_assert(
    refuses(format('select public.add_invoice_line(%L, %L, null, 1, 10)', v_invoice, v_amp)),
    'an issued invoice takes no more lines'
  );
  perform test_assert(
    refuses(format(
      'select public.remove_invoice_line(%L)',
      (select id from invoice_lines where invoice_id = v_invoice limit 1)
    )),
    'nor loses the ones it has'
  );

  -- The rule the original design protects: a converted invoice is the order''s
  -- word, and is never edited on the invoice.
  perform test_assert(
    refuses(format('select public.add_invoice_line(%L, %L, null, 1, 10)', v_from_so, v_amp)),
    'and an invoice from an order is never editable, draft or not'
  );

  -- No write policy exists, so there is no statement that reaches the table.
  perform test_assert(
    refuses(format(
      'update invoice_lines set quantity = 99 where invoice_id = %L', v_invoice
    )),
    'and no direct write reaches an invoice line at all'
  );
end;
$$;

-- =============================================================================
-- A standalone invoice holds stock; one from an order does not hold it twice.
-- =============================================================================
do $$
declare
  v_org     uuid := (select id from fixture where key = 'org');
  v_amp     uuid := (select id from fixture where key = 'amp');
  v_invoice uuid := (select id from fixture where key = 'standalone');
  v_row     record;
  v_before  numeric;
begin
  raise notice 'Stock held by an invoice:';

  perform sign_in_as('mgr_auth');

  select committed_invoices into v_before from public.product_stock_summary(v_amp);
  perform test_assert(v_before = 2, 'a sent invoice holds the two on its line');

  update invoices set status = 'draft' where id = v_invoice;
  perform test_assert(
    (select committed_invoices from public.product_stock_summary(v_amp)) = 0,
    'a draft holds nothing'
  );

  update invoices set status = 'partial' where id = v_invoice;
  perform test_assert(
    (select committed_invoices from public.product_stock_summary(v_amp)) = 2,
    'a part-paid one still holds it'
  );

  -- Paid closes the transaction. Holding stock for every invoice ever settled
  -- would commit the warehouse a slice at a time.
  update invoices set status = 'paid' where id = v_invoice;
  perform test_assert(
    (select committed_invoices from public.product_stock_summary(v_amp)) = 0,
    'a paid one releases it'
  );

  update invoices set status = 'void' where id = v_invoice;
  perform test_assert(
    (select committed_invoices from public.product_stock_summary(v_amp)) = 0,
    'and so does a void one'
  );

  -- The double-count this rule exists to prevent.
  perform test_assert(
    (select count(*) from public.product_stock_summary(v_amp)) = 1,
    'the summary still answers with one row'
  );
end;
$$;

reset role;

rollback;
