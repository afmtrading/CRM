-- =============================================================================
-- What a purchase order says beyond who and what
--
-- Four additions, all to answer questions the document already had to answer
-- and the record could not:
--
--   * a customer id, so a company can be referred to by something short;
--   * a ship-to, because the business paying is not always the address it goes
--     to — a broker buys and a warehouse receives;
--   * whether a deposit is required, and on what terms;
--   * how it ships, and who is responsible for it.
--
-- Nothing here is derived from anything else, which is why all of it is stored
-- rather than computed. A shipping method is a decision somebody made, not a
-- consequence of the order's other fields.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The customer id
--
-- A company's short name, for a document that has to refer to it in a column
-- rather than a paragraph. Derived from the name once, on the way in, and then
-- left alone: a code that followed the name would change under every invoice
-- ever issued against it, and the point of a code is that it does not move.
--
-- Six letters of the name plus a number when that collides, scoped per
-- organization — two tenants may both trade with an "Acme" and neither should
-- learn that from a code clash.
-- -----------------------------------------------------------------------------

alter table public.companies
  add column if not exists code text;

comment on column public.companies.code is
  'Customer ID — a short, stable handle for the company, derived from its name when the row is created and never afterwards.';

create or replace function public.company_code_for(p_org uuid, p_name text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_stem text;
  v_try  text;
  v_n    integer := 1;
begin
  /*
   * Letters and digits only, upper case, first six. Everything else — spaces,
   * ampersands, accents, the "Inc." nobody says out loud — is noise in a
   * handle somebody has to read down a column or say over a phone.
   */
  v_stem := upper(regexp_replace(coalesce(p_name, ''), '[^a-zA-Z0-9]', '', 'g'));
  v_stem := left(v_stem, 6);

  -- A name with no letters at all still needs a handle.
  if v_stem = '' then
    v_stem := 'CUST';
  end if;

  v_try := v_stem;

  /*
   * Then the smallest suffix that is free. Bounded rather than a while-true:
   * a hundred companies whose names reduce to the same six characters is a
   * naming problem, not something to spin on.
   */
  while v_n < 100 and exists (
    select 1 from public.companies
    where organization_id = p_org and code = v_try
  ) loop
    v_n := v_n + 1;
    v_try := v_stem || v_n::text;
  end loop;

  return v_try;
end;
$$;

comment on function public.company_code_for(uuid, text) is
  'The customer id a company would get: six alphanumerics of its name, suffixed until free within the organization.';

create or replace function public.companies_set_code()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only ever fills a blank. An administrator who types a code means it.
  if new.code is null or btrim(new.code) = '' then
    new.code := public.company_code_for(new.organization_id, new.name);
  end if;
  return new;
end;
$$;

drop trigger if exists companies_set_code on public.companies;
create trigger companies_set_code
  before insert on public.companies
  for each row execute function public.companies_set_code();

/*
 * Everything already on file, oldest first.
 *
 * In creation order so the plainest code goes to the company that has been
 * there longest — if two reduce to the same six letters, the newer one takes
 * the suffix, which is the same rule new rows will follow from now on.
 */
do $$
declare
  v_row record;
begin
  for v_row in
    select id, organization_id, name from public.companies
    where code is null or btrim(code) = ''
    order by created_at, id
  loop
    update public.companies
    set code = public.company_code_for(v_row.organization_id, v_row.name)
    where id = v_row.id;
  end loop;
end;
$$;

-- Unique within the organization, and only where there is one: the column is
-- nullable, and two rows without a code are not two rows with the same code.
create unique index if not exists companies_org_code_idx
  on public.companies (organization_id, code)
  where code is not null;

-- -----------------------------------------------------------------------------
-- Ship to, the deposit, and the shipping
--
-- The ship-to pair mirrors the bill-to pair exactly — same tables, same delete
-- rules — because they are the same question asked about a different party.
-- Null means "the same as bill to", which is the ordinary case and is why
-- there is no default and no backfill.
-- -----------------------------------------------------------------------------

alter table public.sales_orders
  add column if not exists ship_to_company_id uuid references public.companies (id) on delete restrict,
  add column if not exists ship_to_contact_id uuid references public.contacts (id) on delete set null,
  add column if not exists shipping_address text,
  add column if not exists deposit_required boolean not null default false,
  add column if not exists deposit_information text,
  add column if not exists shipping_method text,
  add column if not exists shipping_responsibility text;

comment on column public.sales_orders.ship_to_company_id is
  'Where the goods go, when that is not the company being billed. Null means the same as bill to.';
comment on column public.sales_orders.shipping_address is
  'The delivery address as it should print. Free text: an address given for one order is not necessarily the company''s address.';
comment on column public.sales_orders.deposit_required is
  'Whether this order needs money down before it moves. A statement of terms — the deposits actually taken are rows in sales_order_payments.';
comment on column public.sales_orders.shipping_responsibility is
  'Who arranges and pays for carriage — the buyer, the seller, or a named third party.';

create index if not exists sales_orders_ship_to_idx
  on public.sales_orders (organization_id, ship_to_company_id)
  where deleted_at is null;
