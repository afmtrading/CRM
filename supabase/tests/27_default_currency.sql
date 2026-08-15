-- =============================================================================
-- What a new document is priced in.
--
--   The setting existed and the documents ignored it: sales_orders and invoices
--   were written after the USD change with `default 'CAD'` copied from the
--   older tables, so an organization set to USD raised CAD invoices.
--
--   Three things are held here. A raised document takes the organization's
--   currency; an explicit one still wins; and the currency freezes the moment
--   the document is real, because changing it converts nothing — every stored
--   figure keeps its number and acquires a new label.
--
--   And the date, which had the same defect the deal close date did: current_date
--   is the server's today, not the organization's.
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

/** Reads a document past RLS. */
create or replace function doc_currency(p_table text, p_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
begin
  execute format('select currency from public.%I where id = $1', p_table)
  into v_code using p_id;
  return v_code;
end;
$$;

grant execute on function doc_currency(text, uuid) to authenticated;

do $$
declare
  v_org     uuid;
  v_admin_a uuid := gen_random_uuid();
  v_rep_a   uuid := gen_random_uuid();
  v_admin   uuid;
  v_rep     uuid;
begin
  insert into organizations (name, slug) values ('Money Co', 'money-co') returning id into v_org;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@money.test'),
    (v_rep_a, 'rep@money.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@money.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@money.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;

  insert into fixture values
    ('org', v_org), ('admin_auth', v_admin_a), ('rep_auth', v_rep_a),
    ('admin', v_admin), ('rep', v_rep);
end;
$$;

set local role authenticated;

-- =============================================================================
-- A new organization is priced in USD, and its documents follow.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
  v_inv uuid;
  v_so  uuid;
begin
  raise notice 'What a fresh organization raises:';
  perform sign_in_as('admin_auth');

  perform test_assert(
    (select default_currency from organizations where id = v_org) = 'USD',
    'a new organization is priced in USD'
  );
  perform test_assert(public.org_currency(v_org) = 'USD', 'and org_currency agrees');

  v_inv := public.create_invoice();
  v_so  := public.create_sales_order();

  perform test_assert(doc_currency('invoices', v_inv) = 'USD', 'an invoice takes it');
  perform test_assert(doc_currency('sales_orders', v_so) = 'USD', 'and so does a sales order');

  insert into fixture values ('inv', v_inv), ('so', v_so);
end;
$$;

-- =============================================================================
-- Changing the setting changes what is raised next, and nothing already raised.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
  v_old uuid := (select id from fixture where key = 'inv');
  v_new uuid;
begin
  raise notice 'Changing the setting:';
  perform sign_in_as('admin_auth');

  perform public.set_default_currency('eur');
  perform test_assert(
    (select default_currency from organizations where id = v_org) = 'EUR',
    'the code is stored upper case whatever was typed'
  );

  v_new := public.create_invoice();
  perform test_assert(doc_currency('invoices', v_new) = 'EUR', 'the next invoice takes the new one');
  perform test_assert(
    doc_currency('invoices', v_old) = 'USD',
    'and the one raised before it is untouched — a stored figure keeps its unit'
  );

  -- An explicit currency still wins over the setting.
  perform test_assert(
    doc_currency('invoices', public.create_invoice(null, null, null, 'GBP')) = 'GBP',
    'asking for one overrides the default'
  );

  perform public.set_default_currency('USD');
end;
$$;

-- =============================================================================
-- Only an administrator, and only a currency the app can render.
-- =============================================================================
do $$
begin
  raise notice 'Who may change it, and to what:';

  perform sign_in_as('rep_auth');
  begin
    perform public.set_default_currency('CAD');
    perform test_assert(false, 'a rep should not be able to reprice the organization');
  exception when others then
    perform test_assert(sqlerrm like '%administrator%', 'a rep is refused');
  end;

  perform sign_in_as('admin_auth');
  begin
    perform public.set_default_currency('XYZ');
    perform test_assert(false, 'an unknown code should be refused');
  exception when others then
    perform test_assert(
      sqlerrm like '%Unknown currency%',
      'an unknown code is refused rather than stored to render as a blank symbol'
    );
  end;

  perform test_assert(
    public.org_currency((select id from fixture where key = 'org')) = 'USD',
    'and the setting is still what it was'
  );
end;
$$;

-- =============================================================================
-- The currency freezes when the document becomes real.
-- =============================================================================
do $$
declare
  v_inv uuid;
  v_so  uuid := (select id from fixture where key = 'so');
begin
  raise notice 'Freezing:';
  perform sign_in_as('admin_auth');

  v_inv := public.create_invoice();

  -- A draft with nothing against it is a correction, not a restatement.
  update invoices set currency = 'CAD' where id = v_inv;
  perform test_assert(doc_currency('invoices', v_inv) = 'CAD', 'an unpaid draft can be corrected');

  /*
   * A payment is what makes it real. Recording one recomputes the status
   * through invoice_status_for, so the invoice leaves draft and the currency
   * goes with it — which is why the trigger tests draft and nothing else.
   */
  perform public.add_invoice_line(v_inv, null, 'Consultancy', 1, 100, 0);
  insert into invoice_payments (organization_id, invoice_id, amount, created_by)
  values ((select id from fixture where key = 'org'), v_inv, 25,
          (select id from fixture where key = 'admin'));

  perform test_assert(
    (select status from invoices where id = v_inv)::text <> 'draft',
    'a payment takes the invoice out of draft'
  );

  begin
    update invoices set currency = 'EUR' where id = v_inv;
    perform test_assert(false, 'a part-paid invoice should not change currency');
  exception when others then
    perform test_assert(
      sqlerrm like '%left draft%',
      'so its currency is fixed, and the refusal says what to do instead'
    );
  end;
  perform test_assert(doc_currency('invoices', v_inv) = 'CAD', 'and it kept the one it had');

  -- A deposit does the same to an order: it reserves it.
  update sales_orders set status = 'confirmed' where id = v_so;
  begin
    update sales_orders set currency = 'CAD' where id = v_so;
    perform test_assert(false, 'a confirmed order should not change currency');
  exception when others then
    perform test_assert(sqlerrm like '%left draft%', 'a confirmed order is fixed too');
  end;

  -- And an unrelated edit still saves, which is the case a naive guard breaks.
  update sales_orders set payment_terms = 'Net 30' where id = v_so;
  perform test_assert(
    (select payment_terms from sales_orders where id = v_so) = 'Net 30',
    'while everything else about it stays editable'
  );
end;
$$;

-- =============================================================================
-- The document is dated on the organization's calendar.
--
-- issue_date and order_date used current_date, the server's today, which is the
-- same defect 20260241000000 fixed on a deal's close date. Two zones either
-- side of the date line, so this fails under the old behaviour at every hour.
-- =============================================================================
do $$
declare
  v_org  uuid := (select id from fixture where key = 'org');
  v_zone text;
  v_inv  uuid;
  v_so   uuid;
begin
  raise notice 'The date on the document:';
  perform sign_in_as('admin_auth');

  foreach v_zone in array array['Pacific/Kiritimati', 'Pacific/Midway'] loop
    update organizations set timezone = v_zone where id = v_org;

    v_inv := public.create_invoice();
    v_so  := public.create_sales_order();

    perform test_assert(
      (select issue_date from invoices where id = v_inv) = public.org_today(v_org),
      format('an invoice is issued on the organization''s today in %s', v_zone)
    );
    perform test_assert(
      (select order_date from sales_orders where id = v_so) = public.org_today(v_org),
      format('and an order is dated the same way in %s', v_zone)
    );
  end loop;
end;
$$;

rollback;
