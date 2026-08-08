-- =============================================================================
-- One home for option lists
--
-- Until now a select field's values lived in one of two places: the five
-- built-in fields drew coloured options from field_options, while a custom
-- select field kept a plain list of strings in custom_field_definitions.options
-- with no colour and its own editor. This folds custom fields into
-- field_options so every option list works the same way and is edited in one
-- place.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Options belong to a record type as well as a field
--
-- A contact and a company can each define a custom field keyed "region"; they
-- are different fields and must not share one option list.
-- -----------------------------------------------------------------------------
alter table field_options
  add column if not exists entity_type filter_entity_type not null default 'contact';

-- The built-in lists move to whichever record they now describe.
update field_options set entity_type = 'company'
where field_key in ('specialty_market', 'customer_type');

update field_options set entity_type = 'contact'
where field_key in ('role_type', 'priority', 'credibility');

-- -----------------------------------------------------------------------------
-- Any field key is allowed now, not just the five built-ins
-- -----------------------------------------------------------------------------
alter table field_options drop constraint if exists field_options_field_key_check;
alter table field_options add constraint field_options_field_key_check
  check (field_key ~ '^[a-z][a-z0-9_]*$');

-- Uniqueness has to account for the record type.
alter table field_options
  drop constraint if exists field_options_organization_id_field_key_value_key;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'field_options_unique') then
    alter table field_options
      add constraint field_options_unique unique (organization_id, entity_type, field_key, value);
  end if;
end
$$;

drop index if exists field_options_lookup_idx;
create index if not exists field_options_lookup_idx
  on field_options (organization_id, entity_type, field_key, "order");

-- -----------------------------------------------------------------------------
-- Carry existing custom-field option lists across
--
-- They arrive uncoloured; an admin can now give them colours in the same editor
-- the built-in lists use.
-- -----------------------------------------------------------------------------
insert into field_options (organization_id, entity_type, field_key, value, color, "order")
select
  d.organization_id,
  d.entity_type,
  d.key,
  opt.value,
  'slate',
  opt.ord::integer
from custom_field_definitions d
cross join lateral jsonb_array_elements_text(
  case when jsonb_typeof(d.options) = 'array' then d.options else '[]'::jsonb end
) with ordinality as opt(value, ord)
where d.field_type in ('select', 'multiselect')
  and trim(opt.value) <> ''
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Seeding, updated for the new column
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
    ('contact', 'credibility',      'Highly trusted', 'teal',   4)
  ) as d(entity_type, field_key, value, color, ord)
  on conflict do nothing;
$$;

-- -----------------------------------------------------------------------------
-- Renaming or deleting a custom field takes its options with it
--
-- Without this the rows would linger as orphans, invisible in the editor but
-- still occupying the key if the field were ever recreated. There is no foreign
-- key to lean on: options are keyed by name, not by the definition's id.
-- -----------------------------------------------------------------------------
create or replace function custom_field_options_follow_definition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    delete from field_options
    where organization_id = old.organization_id
      and entity_type = old.entity_type
      and field_key = old.key;
    return old;
  end if;

  if new.key <> old.key or new.entity_type <> old.entity_type then
    update field_options
    set field_key = new.key, entity_type = new.entity_type
    where organization_id = old.organization_id
      and entity_type = old.entity_type
      and field_key = old.key;
  end if;

  return new;
end;
$$;

drop trigger if exists custom_field_options_follow_definition on custom_field_definitions;
create trigger custom_field_options_follow_definition
  after update or delete on custom_field_definitions
  for each row execute function custom_field_options_follow_definition();
