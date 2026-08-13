-- =============================================================================
-- Product Type, Condition and Status become the organization's own vocabulary
--
-- The previous migration argued these three were the vocabulary of the trade
-- and so belonged in a check constraint rather than in field_options. That was
-- wrong about who this catalogue is for. A trading company's conditions and
-- statuses are its own — "Reserved", "In Transit", "On Hold" are all real
-- states, and none of them can be added without a deployment while a constraint
-- is the thing that decides. So they move to field_options, where category
-- already lives, and become editable in Settings → Fields.
--
-- WHAT THIS COSTS, AND WHAT IS DONE ABOUT IT
--
-- products.active is derived from the status, and derived values need a rule
-- that survives an admin inventing a status nobody wrote code for. The rule is
-- now: a product is on offer when its status is "Active", and off offer
-- otherwise, whatever the status is called. Add "On Hold" tomorrow and it is
-- correctly not on offer without anybody touching this file.
--
-- The one thing that would break it is renaming or deleting the "Active" option
-- itself, which would take every product off the picker at once. That is loud
-- rather than silent — the whole catalogue disappears from the deal form — and
-- it is recoverable by renaming it back.
--
-- The stored values change from slugs to labels ('open_box' becomes
-- 'Open Box'), because a field_options value is the thing people read.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The constraints go
-- -----------------------------------------------------------------------------
alter table products drop constraint if exists products_product_type_check;
alter table products drop constraint if exists products_condition_check;
alter table products drop constraint if exists products_status_check;

-- -----------------------------------------------------------------------------
-- The rule that survives a vocabulary nobody has written yet
--
-- Case-insensitive because an admin editing the option list is typing into a
-- text box, and "active" and "Active" are the same intention.
--
-- This has to be replaced BEFORE the rename below rather than after it. The
-- rename fires this very trigger, and the version it replaces compared the
-- status to 'active' exactly — so renaming 'active' to 'Active' under the old
-- rule set active = false on every product in the catalogue and quietly emptied
-- the deal picker. Caught by running the migration against a copy of the real
-- data rather than against an empty table.
-- -----------------------------------------------------------------------------
create or replace function public.products_sync_active()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.active := (new.status is null or lower(trim(new.status)) = 'active');
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Slugs become labels
--
-- Written as a mapping rather than a blanket initcap so that anything already
-- holding an unexpected value is left exactly as it is rather than mangled.
-- -----------------------------------------------------------------------------
update products set
  product_type = case product_type
    when 'item'   then 'Item'
    when 'case'   then 'Case'
    when 'pallet' then 'Pallet'
    when 'kit'    then 'Kit'
    when 'bin'    then 'Bin'
    else product_type
  end,
  product_condition = case product_condition
    when 'new'         then 'New'
    when 'open_box'    then 'Open Box'
    when 'damaged'     then 'Damaged'
    when 'refurbished' then 'Refurbished'
    when 'expired'     then 'Expired'
    else product_condition
  end,
  status = case status
    when 'active'       then 'Active'
    when 'inactive'     then 'Inactive'
    when 'discontinued' then 'Discontinued'
    when 'quarantined'  then 'Quarantined'
    when 'sold'         then 'Sold'
    else status
  end;

alter table products alter column status set default 'Active';

comment on column products.status is
  'Drawn from field_options (product_status). Only "Active" is offered on new deals; products.active is derived from it and should not be written directly.';

-- -----------------------------------------------------------------------------
-- The starting vocabulary
--
-- Seeded for the organizations that exist now and, through seed_field_options,
-- for every organization created later. product_category is still seeded with
-- nothing on purpose: what an organization sells is a list this app cannot
-- guess, while "New / Open Box / Damaged" is one it can.
-- -----------------------------------------------------------------------------
create or replace function seed_field_options(p_organization_id uuid)
returns void
language sql
as $$
  insert into field_options (organization_id, entity_type, field_key, value, color, "order")
  select p_organization_id, d.entity_type::filter_entity_type, d.field_key, d.value, d.color, d.ord
  from (values
    ('company', 'specialty_market', 'Foodservice',    'blue',   1),
    ('company', 'specialty_market', 'Retail',         'green',  2),
    ('company', 'specialty_market', 'Wholesale',      'violet', 3),
    ('company', 'specialty_market', 'Industrial',     'orange', 4),
    ('company', 'specialty_market', 'Export',         'cyan',   5),

    ('company', 'customer_type',    'Distributor',    'blue',   1),
    ('company', 'customer_type',    'Broker',         'violet', 2),
    ('company', 'customer_type',    'Manufacturer',   'teal',   3),
    ('company', 'customer_type',    'Retailer',       'green',  4),
    ('company', 'customer_type',    'End user',       'slate',  5),

    ('contact', 'role_type',        'Decision maker', 'green',  1),
    ('contact', 'role_type',        'Influencer',     'blue',   2),
    ('contact', 'role_type',        'Champion',       'violet', 3),
    ('contact', 'role_type',        'Gatekeeper',     'amber',  4),
    ('contact', 'role_type',        'Technical buyer','cyan',   5),
    ('contact', 'role_type',        'End user',       'slate',  6),

    ('contact', 'priority',         'Low',            'slate',  1),
    ('contact', 'priority',         'Standard',       'blue',   2),
    ('contact', 'priority',         'High',           'amber',  3),
    ('contact', 'priority',         'Critical',       'red',    4),

    ('contact', 'credibility',      'Unverified',     'slate',  1),
    ('contact', 'credibility',      'Developing',     'amber',  2),
    ('contact', 'credibility',      'Trusted',        'green',  3),
    ('contact', 'credibility',      'Highly trusted', 'teal',   4),

    ('product', 'product_type',     'Item',           'slate',  1),
    ('product', 'product_type',     'Case',           'blue',   2),
    ('product', 'product_type',     'Pallet',         'violet', 3),
    ('product', 'product_type',     'Kit',            'teal',   4),
    ('product', 'product_type',     'Bin',            'orange', 5),

    ('product', 'product_condition', 'New',           'green',  1),
    ('product', 'product_condition', 'Open Box',      'blue',   2),
    ('product', 'product_condition', 'Damaged',       'red',    3),
    ('product', 'product_condition', 'Refurbished',   'violet', 4),
    ('product', 'product_condition', 'Expired',       'amber',  5),

    -- "Active" is load-bearing: see the header. The rest are ordinary labels.
    ('product', 'product_status',   'Active',         'green',  1),
    ('product', 'product_status',   'Inactive',       'slate',  2),
    ('product', 'product_status',   'Discontinued',   'slate',  3),
    ('product', 'product_status',   'Quarantined',    'amber',  4),
    ('product', 'product_status',   'Sold',           'blue',   5)
  ) as d(entity_type, field_key, value, color, ord)
  on conflict do nothing;
$$;

select seed_field_options(id) from organizations;

-- -----------------------------------------------------------------------------
-- The unit of measure goes
--
-- Count, Size and Case Pack say what a unit is made of, which is what anybody
-- actually wanted to know; "kg, MT, container" was the commodity-era way of
-- saying the same thing and now sits alongside them saying it worse. The column
-- stays so that deals written against it keep rendering, but nothing offers to
-- fill it any more.
-- -----------------------------------------------------------------------------
comment on column products.unit is
  'Retired from the product form. Kept so existing line items still render what they were counted in.';

-- -----------------------------------------------------------------------------
-- Dollars mean US dollars
--
-- Only the defaults change. Amounts already stored keep the currency they were
-- entered in — rewriting the code on a row would turn 100 Canadian dollars into
-- 100 American ones without anybody agreeing to the rate.
-- -----------------------------------------------------------------------------
alter table organizations alter column default_currency set default 'USD';
alter table products      alter column currency         set default 'USD';
alter table deals         alter column currency         set default 'USD';

update organizations set default_currency = 'USD' where default_currency <> 'USD';
