-- -----------------------------------------------------------------------------
-- One organization, one default currency
--
-- 20260221000000 moved the defaults to USD — organizations.default_currency,
-- products.currency, deals.currency. Sales orders and invoices were built after
-- it, in 20260229000000, and were written with `default 'CAD'` copied from the
-- older tables. So the setting said USD and every invoice raised came out CAD,
-- which is what the totals panel has been showing.
--
-- Correcting the literal to 'USD' would fix today and reintroduce the same bug
-- the next time somebody changes the setting, because a column default cannot
-- read another table. The fix is to stop the documents having an opinion: the
-- functions that raise them fall back to the organization's setting, and the
-- column default becomes a backstop for a direct insert rather than the rule.
--
-- Amounts already stored keep the currency they were entered in. A stored
-- number means nothing without the unit it was typed in, and rewriting the
-- label without touching the figure would silently restate every historical
-- document.
-- -----------------------------------------------------------------------------

alter table public.sales_orders alter column currency set default 'USD';
alter table public.invoices     alter column currency set default 'USD';

comment on column public.organizations.default_currency is
  'What a new deal, product, order or invoice is priced in unless somebody says otherwise. Changing it never restates a document already raised.';

/**
 * The organization's default currency, or USD if it has none.
 *
 * Takes the organization rather than reading current_org_id(), for the same
 * reason org_today does: this is called from document-creation functions that
 * also run for imports and service-role work.
 */
create or replace function public.org_currency(p_org uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif((select o.default_currency from public.organizations o where o.id = p_org), ''),
    'USD'
  );
$$;

revoke execute on function public.org_currency(uuid) from public, anon;
grant execute on function public.org_currency(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Raising a document
--
-- Both functions recreated whole. The only changes are the currency fallback
-- and the date: issue_date and order_date used `current_date`, the server's
-- today, which is the same defect 20260241000000 fixed on a deal's close date.
-- An invoice raised at 8pm in Toronto was dated tomorrow, and its own header
-- said so.
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
    coalesce(nullif(p_currency, ''), public.org_currency(v_org)),
    public.org_today(v_org),
    v_actor
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_invoice(uuid, uuid, uuid, text) is
  'Raises an empty draft invoice with no sales order behind it. The number is allocated in the same transaction as the row, and the currency and date are the organization''s own unless overridden.';

create or replace function public.create_sales_order(
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
  v_name  text;
  v_id    uuid;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow creating a sales order';
  end if;

  if p_company_id is not null then
    select name into v_name
    from public.companies
    where id = p_company_id and organization_id = v_org;

    if v_name is null then
      raise exception 'Company not found';
    end if;
  end if;

  insert into public.sales_orders (
    organization_id, number, company_id, contact_id, owner_id, currency,
    order_date, created_by, updated_by
  )
  values (
    v_org,
    public.next_document_number(v_org, 'SO', public.sales_order_slug(v_name)),
    p_company_id,
    p_contact_id,
    -- Unowned orders are invisible to a rep under can_see_owned, so the creator
    -- is the sensible default rather than nobody.
    coalesce(p_owner_id, v_actor),
    coalesce(nullif(p_currency, ''), public.org_currency(v_org)),
    -- Was the column default, current_date: the server's today rather than this
    -- organization's. Named explicitly so the two cannot drift apart again.
    public.org_today(v_org),
    v_actor,
    v_actor
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_sales_order(uuid, uuid, uuid, text) is
  'Raises an empty draft sales order. The number is allocated in the same transaction as the row, and the currency and date are the organization''s own unless overridden.';

-- -----------------------------------------------------------------------------
-- Changing the setting
--
-- A definer function rather than an update policy on organizations, because the
-- table holds more than this — branding, slug, timezone — and a policy wide
-- enough to let somebody set a currency is wide enough to let them rename the
-- company. This writes one column and refuses anybody who cannot administer.
--
-- The currency is checked against a list. It ends up on printed documents and
-- in Intl.NumberFormat, and a typo would render as a blank symbol on an invoice
-- that had already gone out.
-- -----------------------------------------------------------------------------

create or replace function public.set_default_currency(p_currency text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org  uuid := public.current_org_id();
  v_code text := upper(trim(coalesce(p_currency, '')));
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can change the default currency';
  end if;

  if v_code not in ('USD', 'CAD', 'EUR', 'GBP') then
    raise exception 'Unknown currency: %', p_currency;
  end if;

  update public.organizations set default_currency = v_code where id = v_org;
end;
$$;

comment on function public.set_default_currency(text) is
  'Sets what new deals, products, orders and invoices are priced in. Never restates anything already raised.';

revoke execute on function public.set_default_currency(text) from public, anon;
grant execute on function public.set_default_currency(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Freezing the currency once a document is real
--
-- A currency is not an ordinary editable field. Changing it does not convert
-- anything — every stored figure keeps its number and acquires a new label — so
-- on a document that has been sent, or that has money against it, it is a way
-- to restate history by accident.
--
-- Still a draft, it is a correction. Anything else, it is refused.
--
-- Draft is the whole test, and that is not an oversight. A second condition —
-- "and no money against it" — was written here and taken out again, because it
-- can never fire: a payment on a draft invoice recomputes its status through
-- invoice_status_for, and a deposit on a draft order reserves it. Money and
-- draft are mutually exclusive by construction, so the extra clause was a guard
-- that reads like a safeguard and never runs, which is worse than not having it.
-- -----------------------------------------------------------------------------

create or replace function public.documents_freeze_currency()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.currency is not distinct from old.currency then
    return new;
  end if;

  if old.status::text <> 'draft' then
    raise exception
      'The currency of a % cannot change once it has left draft — void it and raise another',
      tg_table_name;
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_freeze_currency on public.invoices;
create trigger invoices_freeze_currency
  before update of currency on public.invoices
  for each row execute function public.documents_freeze_currency();

drop trigger if exists sales_orders_freeze_currency on public.sales_orders;
create trigger sales_orders_freeze_currency
  before update of currency on public.sales_orders
  for each row execute function public.documents_freeze_currency();

revoke execute on function public.documents_freeze_currency() from public, anon, authenticated;
