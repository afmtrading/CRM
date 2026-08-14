-- =============================================================================
-- Sales orders and invoices
--
-- The CRM's version of the two documents the Inventory app already runs the
-- business on. See docs/SALES_ORDERS_INVOICES.md for the mapping; the rules
-- that must hold are all here.
--
-- THESE ARE NOT DEALS. There is deliberately no deal_id on either table and no
-- foreign key between them. A deal asks "will we win this"; a sales order says
-- "this is what they bought". Coupling them would mean every order status
-- change had to reason about deal state, and closing a deal would mean two
-- different things depending on whether an order existed yet.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Status
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'sales_order_status') then
    create type sales_order_status as enum (
      'draft',      -- being written; commits to nothing
      'reserved',   -- signed, or a deposit taken
      'confirmed',  -- committed and ready to invoice
      'fulfilled',  -- delivered and done
      'cancelled'   -- did not happen; terminal
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'invoice_status') then
    create type invoice_status as enum (
      'draft',
      'sent',      -- the only one set by hand
      'partial',   -- computed from the payment ledger
      'paid',      -- computed from the payment ledger
      'void'       -- sticky: once void, always void
    );
  end if;

  -- How a line's price was revised: a percentage off, or a replacement unit
  -- price. Null means the list price stands.
  if not exists (select 1 from pg_type where typname = 'revised_rate_type') then
    create type revised_rate_type as enum ('percent', 'fixed');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- The discount rule, in one place
--
-- Written as a function rather than repeated in two generated columns and again
-- in the invoice conversion, because three copies of a money formula is three
-- chances for them to drift apart. Immutable so a generated column may call it.
--
-- Both clamps matter. A fixed price above list produces no discount rather than
-- a negative one, and a percentage over 100 produces the whole line rather than
-- a negative unit price.
-- -----------------------------------------------------------------------------
create or replace function public.sales_line_discount(
  p_quantity    numeric,
  p_unit_price  numeric,
  p_rate_type   revised_rate_type,
  p_rate        numeric
)
returns numeric
language sql
immutable
parallel safe
as $$
  select round(
    greatest(
      0,
      coalesce(p_quantity, 0) * coalesce(p_unit_price, 0)
        - coalesce(p_quantity, 0) * greatest(
            0,
            case
              when p_rate_type is null or p_rate is null then coalesce(p_unit_price, 0)
              when p_rate_type = 'percent' then coalesce(p_unit_price, 0) * (1 - p_rate / 100)
              when p_rate_type = 'fixed'   then p_rate
            end
          )
    ),
    2
  );
$$;

comment on function public.sales_line_discount(numeric, numeric, revised_rate_type, numeric) is
  'Money off one line, given its revised rate. The single definition of the rule — SQL and TypeScript both follow it.';

/** The company-name part of a sales order number: first word, letters and digits only. */
create or replace function public.sales_order_slug(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select coalesce(
    regexp_replace(split_part(btrim(coalesce(p_name, '')), ' ', 1), '[^A-Za-z0-9]', '', 'g'),
    ''
  );
$$;

-- -----------------------------------------------------------------------------
-- Sales orders
-- -----------------------------------------------------------------------------

create table if not exists sales_orders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  /** SO-Acme-0001. Allocated once, at creation, and never reissued. */
  number          text not null,
  /** Who is billed. Restricted rather than cascaded: deleting a company must
      never quietly remove the record of what they bought. */
  company_id      uuid references companies (id) on delete restrict,
  /** Who to call about it. */
  contact_id      uuid references contacts (id) on delete set null,
  /** The salesperson. A user, not a separate list of names — this CRM already
      has ownership and the visibility rules that come with it. */
  owner_id        uuid references users (id) on delete set null,
  location_id     uuid references stock_locations (id) on delete set null,
  status          sales_order_status not null default 'draft',
  currency        text not null default 'CAD',
  order_date      date not null default current_date,
  payment_terms   text,
  shipping_charge numeric(14, 2) not null default 0 check (shipping_charge >= 0),
  /** Shown to the customer on the document. */
  notes           text,
  terms           text,
  /** Set when the order is first reserved — signed, or a deposit taken. */
  signed_at       timestamptz,
  created_by      uuid references users (id) on delete set null,
  updated_by      uuid references users (id) on delete set null,
  deleted_at      timestamptz,
  deleted_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists sales_orders_number_key
  on sales_orders (organization_id, lower(number));
create index if not exists sales_orders_org_idx
  on sales_orders (organization_id, order_date desc) where deleted_at is null;
create index if not exists sales_orders_company_idx
  on sales_orders (organization_id, company_id) where deleted_at is null;
create index if not exists sales_orders_owner_idx
  on sales_orders (organization_id, owner_id) where deleted_at is null;
create index if not exists sales_orders_status_idx
  on sales_orders (organization_id, status) where deleted_at is null;

drop trigger if exists sales_orders_updated_at on sales_orders;
create trigger sales_orders_updated_at
  before update on sales_orders
  for each row execute function set_updated_at();

create table if not exists sales_order_lines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  sales_order_id  uuid not null references sales_orders (id) on delete cascade,
  /** Null for a one-off line that is not in the catalogue. */
  product_id      uuid references products (id) on delete restrict,
  /** The name of a one-off line. Required when there is no product. */
  description     text,
  notes           text,
  quantity        numeric(14, 3) not null default 1 check (quantity >= 0),
  unit_price      numeric(14, 2) not null default 0 check (unit_price >= 0),
  unit_cost       numeric(14, 2) not null default 0 check (unit_cost >= 0),
  revised_rate_type revised_rate_type,
  revised_rate    numeric(14, 2) check (revised_rate >= 0),
  /*
   * Money off, in the order's currency. Written by the trigger below and by
   * nothing else — a client cannot send a discount that does not follow from
   * the rate it also sent.
   */
  discount        numeric(14, 2) not null default 0 check (discount >= 0),
  /*
   * Generated, so a line total can never disagree with the numbers above it.
   * Computed after the BEFORE trigger has set discount.
   */
  line_total      numeric(14, 2)
    generated always as (round(quantity * unit_price, 2) - discount) stored,
  line_cost       numeric(14, 2)
    generated always as (round(quantity * unit_cost, 2)) stored,
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint sales_order_lines_named
    check (product_id is not null or nullif(btrim(coalesce(description, '')), '') is not null),
  -- A revised rate is a pair. Half of one is a line nobody can price.
  constraint sales_order_lines_rate_pair
    check ((revised_rate_type is null) = (revised_rate is null))
);

create index if not exists sales_order_lines_order_idx
  on sales_order_lines (sales_order_id, position);
create index if not exists sales_order_lines_product_idx
  on sales_order_lines (organization_id, product_id);

drop trigger if exists sales_order_lines_updated_at on sales_order_lines;
create trigger sales_order_lines_updated_at
  before update on sales_order_lines
  for each row execute function set_updated_at();

/**
 * The one writer of a line's discount.
 *
 * Runs before the generated line_total is computed, so the two are always
 * consistent with each other and with the rate the user actually entered.
 */
create or replace function public.sales_order_lines_apply_discount()
returns trigger
language plpgsql
as $$
begin
  new.discount := public.sales_line_discount(
    new.quantity, new.unit_price, new.revised_rate_type, new.revised_rate
  );
  return new;
end;
$$;

drop trigger if exists sales_order_lines_discount on sales_order_lines;
create trigger sales_order_lines_discount
  before insert or update on sales_order_lines
  for each row execute function public.sales_order_lines_apply_discount();

/** Both ends of a line belong to the line's own organization. */
create or replace function public.sales_order_lines_validate_parents()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.sales_orders o
    where o.id = new.sales_order_id and o.organization_id = new.organization_id
  ) then
    raise exception 'Sales order does not belong to this organization';
  end if;

  if new.product_id is not null and not exists (
    select 1 from public.products p
    where p.id = new.product_id and p.organization_id = new.organization_id
  ) then
    raise exception 'Product does not belong to this organization';
  end if;

  return new;
end;
$$;

drop trigger if exists sales_order_lines_parents on sales_order_lines;
create trigger sales_order_lines_parents
  before insert or update on sales_order_lines
  for each row execute function public.sales_order_lines_validate_parents();

-- -----------------------------------------------------------------------------
-- Deposits on a sales order
--
-- Append-only. A row is a deposit (positive) or a reversal (negative); nothing
-- is ever edited or deleted, so the ledger is what happened rather than what
-- somebody last thought. The policies below grant insert and select and no more.
-- -----------------------------------------------------------------------------

create table if not exists sales_order_payments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  sales_order_id  uuid not null references sales_orders (id) on delete cascade,
  /** Positive is money in, negative reverses an earlier row. Never zero. */
  amount          numeric(14, 2) not null check (amount <> 0),
  method          text,
  note            text,
  paid_at         timestamptz not null default now(),
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists sales_order_payments_order_idx
  on sales_order_payments (sales_order_id, paid_at);

/**
 * Guards the deposit ledger, and reserves the order on its first deposit.
 *
 * Three rules, all of which have to hold at the moment of writing rather than
 * when a screen last rendered: a cancelled order takes no money, an invoiced
 * order takes its money on the invoice, and a reversal cannot take the net
 * below zero.
 */
create or replace function public.sales_order_payments_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status sales_order_status;
  v_net    numeric;
begin
  select status into v_status
  from public.sales_orders
  where id = new.sales_order_id and organization_id = new.organization_id;

  if v_status is null then
    raise exception 'Sales order not found';
  end if;
  if v_status = 'cancelled' then
    raise exception 'Cannot record a deposit on a cancelled order';
  end if;
  if exists (select 1 from public.invoices i where i.sales_order_id = new.sales_order_id) then
    raise exception 'This order is invoiced — record payments on the invoice instead';
  end if;

  if new.amount < 0 then
    select coalesce(sum(amount), 0) into v_net
    from public.sales_order_payments
    where sales_order_id = new.sales_order_id;

    if v_net + new.amount < 0 then
      raise exception 'Reversal exceeds the deposits on record';
    end if;
  end if;

  -- The first money in is what makes a draft real. Mirrors the Inventory app,
  -- where a deposit signs the order and holds the stock.
  if v_status = 'draft' and new.amount > 0 then
    update public.sales_orders
    set status = 'reserved', signed_at = coalesce(signed_at, now())
    where id = new.sales_order_id;
  end if;

  return new;
end;
$$;

drop trigger if exists sales_order_payments_guard on sales_order_payments;
create trigger sales_order_payments_guard
  before insert on sales_order_payments
  for each row execute function public.sales_order_payments_guard();

-- -----------------------------------------------------------------------------
-- Invoices
--
-- A snapshot, not a view. Its totals are stored and its lines carry the
-- product's name as text, so editing the order afterwards does not move it.
-- Everything else in this schema derives rather than stores; an invoice is the
-- one place where storing is right, because it was true on the day it was
-- issued and has to stay true.
-- -----------------------------------------------------------------------------

create table if not exists invoices (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  number          text not null,
  /** The order it came from, if any. An invoice may also stand alone. */
  sales_order_id  uuid references sales_orders (id) on delete set null,
  company_id      uuid references companies (id) on delete restrict,
  contact_id      uuid references contacts (id) on delete set null,
  owner_id        uuid references users (id) on delete set null,
  /** The salesperson's name as it read at issue. The document does not change
      when somebody leaves. */
  owner_name      text,
  status          invoice_status not null default 'draft',
  currency        text not null default 'CAD',
  issue_date      date not null default current_date,
  due_date        date,
  subtotal        numeric(14, 2) not null default 0,
  shipping_charge numeric(14, 2) not null default 0 check (shipping_charge >= 0),
  total           numeric(14, 2) not null default 0,
  /** Maintained by the payment ledger's trigger and by nothing else. */
  amount_paid     numeric(14, 2) not null default 0,
  payment_terms   text,
  notes           text,
  terms           text,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists invoices_number_key
  on invoices (organization_id, lower(number));
-- One invoice per order. Partial, so any number of invoices may stand alone.
create unique index if not exists invoices_order_key
  on invoices (sales_order_id) where sales_order_id is not null;
create index if not exists invoices_org_idx on invoices (organization_id, issue_date desc);
create index if not exists invoices_status_idx on invoices (organization_id, status);
create index if not exists invoices_company_idx on invoices (organization_id, company_id);
create index if not exists invoices_owner_idx on invoices (organization_id, owner_id);

drop trigger if exists invoices_updated_at on invoices;
create trigger invoices_updated_at
  before update on invoices
  for each row execute function set_updated_at();

create table if not exists invoice_lines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  invoice_id      uuid not null references invoices (id) on delete cascade,
  /** Reference only, and nulled if the product goes: the name below is what the
      document says, and it does not change. */
  product_id      uuid references products (id) on delete set null,
  name            text not null,
  sku             text,
  notes           text,
  quantity        numeric(14, 3) not null check (quantity >= 0),
  unit_price      numeric(14, 2) not null check (unit_price >= 0),
  unit_cost       numeric(14, 2) not null default 0 check (unit_cost >= 0),
  discount        numeric(14, 2) not null default 0 check (discount >= 0),
  /** Stored, not generated: a snapshot of the arithmetic as it stood at issue. */
  line_total      numeric(14, 2) not null,
  position        integer not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists invoice_lines_invoice_idx on invoice_lines (invoice_id, position);

create table if not exists invoice_payments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  invoice_id      uuid not null references invoices (id) on delete cascade,
  amount          numeric(14, 2) not null check (amount <> 0),
  method          text,
  note            text,
  paid_at         timestamptz not null default now(),
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists invoice_payments_invoice_idx on invoice_payments (invoice_id, paid_at);

/**
 * What an invoice's status is, given the money.
 *
 * Void is sticky — a voided invoice that later receives a payment is still
 * void, and somebody has some explaining to do. Sent survives a part payment
 * only until there is one: paid and partial are facts about money, and they
 * outrank a flag somebody set by hand.
 */
create or replace function public.invoice_status_for(
  p_total   numeric,
  p_paid    numeric,
  p_current invoice_status
)
returns invoice_status
language sql
immutable
parallel safe
as $$
  select case
    when p_current = 'void' then 'void'::invoice_status
    when coalesce(p_paid, 0) <= 0 then
      case when p_current = 'sent' then 'sent'::invoice_status else 'draft'::invoice_status end
    when coalesce(p_paid, 0) >= coalesce(p_total, 0) then 'paid'::invoice_status
    else 'partial'::invoice_status
  end;
$$;

/**
 * The one door onto amount_paid.
 *
 * The ledger is the only thing that may move it, and the status follows from
 * it. There is no code path — server action, SQL, or otherwise — that can mark
 * an invoice paid without a payment behind it, which is the whole reason this
 * lives in the database rather than in a server action.
 */
create or replace function public.invoice_payments_apply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice invoices%rowtype;
  v_net     numeric;
begin
  select * into v_invoice
  from public.invoices
  where id = new.invoice_id and organization_id = new.organization_id;

  if v_invoice.id is null then
    raise exception 'Invoice not found';
  end if;
  if v_invoice.status = 'void' then
    raise exception 'Cannot record a payment on a void invoice';
  end if;

  select coalesce(sum(amount), 0) into v_net
  from public.invoice_payments
  where invoice_id = new.invoice_id;

  if v_net + new.amount < 0 then
    raise exception 'Reversal exceeds the payments on record';
  end if;

  update public.invoices
  set amount_paid = v_net + new.amount,
      status = public.invoice_status_for(v_invoice.total, v_net + new.amount, v_invoice.status)
  where id = new.invoice_id;

  return new;
end;
$$;

drop trigger if exists invoice_payments_apply on invoice_payments;
create trigger invoice_payments_apply
  before insert on invoice_payments
  for each row execute function public.invoice_payments_apply();

-- -----------------------------------------------------------------------------
-- Row level security
--
-- Sales orders follow deals: a rep sees their own, a manager sees the
-- organization's. Lines and payments inherit their document's visibility rather
-- than restating it, so there is one answer to "who can see this order" and the
-- children cannot drift from it.
-- -----------------------------------------------------------------------------

alter table sales_orders enable row level security;
alter table sales_orders force row level security;
alter table sales_order_lines enable row level security;
alter table sales_order_lines force row level security;
alter table sales_order_payments enable row level security;
alter table sales_order_payments force row level security;
alter table invoices enable row level security;
alter table invoices force row level security;
alter table invoice_lines enable row level security;
alter table invoice_lines force row level security;
alter table invoice_payments enable row level security;
alter table invoice_payments force row level security;

drop policy if exists sales_orders_select on sales_orders;
create policy sales_orders_select on sales_orders
  for select to authenticated
  using (organization_id = public.current_org_id() and public.can_see_owned(owner_id));

drop policy if exists sales_orders_insert on sales_orders;
create policy sales_orders_insert on sales_orders
  for insert to authenticated
  with check (organization_id = public.current_org_id() and public.can_write_records());

drop policy if exists sales_orders_update on sales_orders;
create policy sales_orders_update on sales_orders
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and public.can_see_owned(owner_id)
  )
  with check (organization_id = public.current_org_id() and public.can_write_records());

drop policy if exists sales_orders_delete on sales_orders;
create policy sales_orders_delete on sales_orders
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());

-- Lines: visible exactly when their order is, writable exactly when it is.
drop policy if exists sales_order_lines_select on sales_order_lines;
create policy sales_order_lines_select on sales_order_lines
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and exists (select 1 from sales_orders o where o.id = sales_order_lines.sales_order_id)
  );

drop policy if exists sales_order_lines_write on sales_order_lines;
create policy sales_order_lines_write on sales_order_lines
  for all to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and exists (select 1 from sales_orders o where o.id = sales_order_lines.sales_order_id)
  )
  with check (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and exists (select 1 from sales_orders o where o.id = sales_order_lines.sales_order_id)
  );

/*
 * Deposits are append-only: select and insert, and no update or delete policy
 * at all. A correction is a reversing row. Without an UPDATE policy there is no
 * statement anybody can write that edits one, which is a stronger guarantee
 * than a rule in a server action.
 */
drop policy if exists sales_order_payments_select on sales_order_payments;
create policy sales_order_payments_select on sales_order_payments
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and exists (select 1 from sales_orders o where o.id = sales_order_payments.sales_order_id)
  );

drop policy if exists sales_order_payments_insert on sales_order_payments;
create policy sales_order_payments_insert on sales_order_payments
  for insert to authenticated
  with check (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and exists (select 1 from sales_orders o where o.id = sales_order_payments.sales_order_id)
  );

drop policy if exists invoices_select on invoices;
create policy invoices_select on invoices
  for select to authenticated
  using (organization_id = public.current_org_id() and public.can_see_owned(owner_id));

drop policy if exists invoices_insert on invoices;
create policy invoices_insert on invoices
  for insert to authenticated
  with check (organization_id = public.current_org_id() and public.can_write_records());

/*
 * The header is editable — due date, terms, notes, and marking one sent or
 * void. The money is not: subtotal, total and amount_paid are written by the
 * conversion function and the payment trigger, both of which run as definer and
 * are not subject to this policy.
 */
drop policy if exists invoices_update on invoices;
create policy invoices_update on invoices
  for update to authenticated
  using (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and public.can_see_owned(owner_id)
  )
  with check (organization_id = public.current_org_id() and public.can_write_records());

-- A wrong invoice is voided, not deleted. Deleting one outright is an
-- administrator's job, and it frees the order to be invoiced again.
drop policy if exists invoices_delete on invoices;
create policy invoices_delete on invoices
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());

/*
 * An invoice line is a snapshot. It is readable with its invoice and written
 * only by the definer functions that issue one — no write policy exists, so
 * nobody can quietly restate what a document said.
 */
drop policy if exists invoice_lines_select on invoice_lines;
create policy invoice_lines_select on invoice_lines
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and exists (select 1 from invoices i where i.id = invoice_lines.invoice_id)
  );

drop policy if exists invoice_payments_select on invoice_payments;
create policy invoice_payments_select on invoice_payments
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and exists (select 1 from invoices i where i.id = invoice_payments.invoice_id)
  );

drop policy if exists invoice_payments_insert on invoice_payments;
create policy invoice_payments_insert on invoice_payments
  for insert to authenticated
  with check (
    organization_id = public.current_org_id()
    and public.can_write_records()
    and exists (select 1 from invoices i where i.id = invoice_payments.invoice_id)
  );

-- -----------------------------------------------------------------------------
-- Document numbering
--
-- SO-Acme-0001 per company, INV-0001 per organization. Allocated inside the
-- caller's transaction under an advisory lock keyed to the organization, so two
-- people saving at the same moment cannot take the same number. The lock is
-- transaction-scoped: it releases on commit without anything having to remember.
--
-- The maximum is scanned rather than kept in a sequence because a sequence
-- cannot be per-company, and because a gap in an invoice sequence is the kind
-- of thing an auditor asks about. Under the lock, a scan is exact.
-- -----------------------------------------------------------------------------
create or replace function public.next_document_number(
  p_org  uuid,
  p_kind text,          -- 'SO' or 'INV'; also part of the lock key
  p_slug text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text;
  v_len    integer;
  v_max    integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_kind || ':' || p_org::text, 0));

  v_prefix := case
    when coalesce(nullif(p_slug, ''), '') = '' then p_kind || '-'
    else p_kind || '-' || p_slug || '-'
  end;
  v_len := length(v_prefix);

  /*
   * Matched by prefix and an all-digit remainder rather than by a pattern, so
   * the bare "SO-0001" sequence never picks up "SO-Acme-0001" — its remainder
   * is "Acme-0001", which is not a number — and neither counts the other's
   * rows. Each prefix therefore counts from one.
   */
  select coalesce(max(substring(number from v_len + 1)::integer), 0)
  into v_max
  from (
    select number from public.sales_orders where organization_id = p_org and p_kind = 'SO'
    union all
    select number from public.invoices where organization_id = p_org and p_kind = 'INV'
  ) taken
  where left(number, v_len) = v_prefix
    and substring(number from v_len + 1) ~ '^[0-9]+$';

  return v_prefix || lpad((v_max + 1)::text, 4, '0');
end;
$$;

comment on function public.next_document_number(uuid, text, text) is
  'The next SO- or INV- number for an organization, allocated under a transaction-scoped advisory lock.';

-- -----------------------------------------------------------------------------
-- Creating a sales order
--
-- A function rather than a plain insert only because the number has to be
-- allocated in the same transaction as the row it goes on. Everything else
-- about the order is an ordinary RLS-governed update afterwards.
-- -----------------------------------------------------------------------------
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
    organization_id, number, company_id, contact_id, owner_id, currency, created_by, updated_by
  )
  values (
    v_org,
    public.next_document_number(v_org, 'SO', public.sales_order_slug(v_name)),
    p_company_id,
    p_contact_id,
    -- Unowned orders are invisible to a rep under can_see_owned, so the creator
    -- is the sensible default rather than nobody.
    coalesce(p_owner_id, v_actor),
    coalesce(nullif(p_currency, ''), 'CAD'),
    v_actor,
    v_actor
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Converting an order to an invoice
--
-- One transaction, because a half-written invoice is worse than none: the
-- number, the header, the snapshot lines and the carried-over deposits either
-- all land or none do.
--
-- Idempotent. Two people clicking Invoice at the same moment get the same
-- invoice back rather than two documents and a duplicated debt — the unique
-- index on sales_order_id is what actually decides, and the exception handler
-- turns losing that race into the right answer.
-- -----------------------------------------------------------------------------
create or replace function public.convert_sales_order_to_invoice(p_sales_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
      payment_terms, notes, terms, created_by
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
      current_date,
      v_subtotal,
      v_order.shipping_charge,
      v_total,
      v_paid,
      v_order.payment_terms,
      v_order.notes,
      v_order.terms,
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
$$;

comment on function public.convert_sales_order_to_invoice(uuid) is
  'Snapshots a confirmed sales order as an invoice, carrying its deposits over. Idempotent: returns the existing invoice if there is one.';

-- -----------------------------------------------------------------------------
-- Soft delete, matching deals and products
-- -----------------------------------------------------------------------------

create or replace function public.soft_delete_sales_order(p_sales_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_actor   uuid := public.current_app_user_id();
  v_visible boolean;
  v_number  text;
begin
  if not public.can_delete_records() then
    raise exception 'Your role does not allow deleting records';
  end if;

  select public.can_see_owned(owner_id), number
  into v_visible, v_number
  from public.sales_orders
  where id = p_sales_order_id and organization_id = v_org and deleted_at is null;

  if v_visible is not true then
    raise exception 'Sales order not found';
  end if;

  -- An invoiced order is the evidence behind a document somebody has been sent.
  if exists (select 1 from public.invoices where sales_order_id = p_sales_order_id) then
    raise exception 'This order has been invoiced. Void the invoice first.';
  end if;

  update public.sales_orders
  set deleted_at = now(), deleted_by = v_actor
  where id = p_sales_order_id and organization_id = v_org;
end;
$$;

create or replace function public.restore_sales_order(p_sales_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.can_delete_records() then
    raise exception 'Your role does not allow restoring records';
  end if;

  update public.sales_orders
  set deleted_at = null, deleted_by = null
  where id = p_sales_order_id and organization_id = v_org and deleted_at is not null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

grant select, insert, update, delete on sales_orders to authenticated;
grant select, insert, update, delete on sales_order_lines to authenticated;
-- Append-only: no update, no delete. Corrections are reversing rows.
grant select, insert on sales_order_payments to authenticated;
grant select, insert, update, delete on invoices to authenticated;
-- A snapshot: readable, and written only by convert_sales_order_to_invoice.
grant select on invoice_lines to authenticated;
grant select, insert on invoice_payments to authenticated;

revoke execute on function public.create_sales_order(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.create_sales_order(uuid, uuid, uuid, text) to authenticated, service_role;

revoke execute on function public.convert_sales_order_to_invoice(uuid) from public, anon;
grant execute on function public.convert_sales_order_to_invoice(uuid) to authenticated, service_role;

revoke execute on function public.soft_delete_sales_order(uuid) from public, anon;
grant execute on function public.soft_delete_sales_order(uuid) to authenticated, service_role;

revoke execute on function public.restore_sales_order(uuid) from public, anon;
grant execute on function public.restore_sales_order(uuid) to authenticated, service_role;

revoke execute on function public.next_document_number(uuid, text, text) from public, anon;
grant execute on function public.next_document_number(uuid, text, text) to authenticated, service_role;
