-- =============================================================================
-- Companies get a priority
--
-- Priority existed on contacts and nowhere else, which made "Priority: same as
-- the company" impossible to honour — there was no company priority to be the
-- same as. Marketplaces were given one of their own as a stopgap, with a note
-- saying it should follow a company column rather than the other way round.
-- This is that column, and the stopgap goes.
--
-- ONE CONCEPT, TWO LISTS
--
-- The values are seeded to match the contacts' list, so "Critical" starts out
-- meaning the same thing on both. They are separate lists after that, which is
-- deliberate rather than a shortcut: every other select field in this schema is
-- scoped to an entity, Settings → Fields is grouped that way, and a shared list
-- would be the only one that is not. It also turns out to be the truer model —
-- a Critical account can have a Standard person at it, and one list would make
-- those the same statement.
-- =============================================================================

alter table public.companies
  add column if not exists priority text;

comment on column public.companies.priority is
  'How much this account matters. Drawn from the company priority list in Settings → Fields, seeded to match the contacts'' one.';

-- The same four values contacts start with, so the two lists agree on day one.
insert into public.field_options (organization_id, entity_type, field_key, value, color, "order")
select o.id, 'company', 'priority', v.value, v.color, v.ord
from public.organizations o
cross join (values
  ('Critical', 'red',    0),
  ('High',     'orange', 1),
  ('Standard', 'blue',   2),
  ('Low',      'slate',  3)
) as v(value, color, ord)
on conflict do nothing;

/*
 * An organization that has already renamed its contact priorities keeps them:
 * whatever it uses there is copied across, so the company list matches the one
 * people are already reading rather than the four seeded above.
 */
insert into public.field_options (organization_id, entity_type, field_key, value, color, "order")
select o.organization_id, 'company', 'priority', o.value, o.color, o."order"
from public.field_options o
where o.entity_type = 'contact' and o.field_key = 'priority'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- The stopgap, moved up
--
-- Anything already recorded against a marketplace becomes the company's, before
-- the column holding it is dropped. Only where the company has none of its own,
-- so this can never overwrite an answer somebody gave directly.
-- -----------------------------------------------------------------------------

update public.companies c
set priority = p.priority
from public.marketplace_profiles p
where p.company_id = c.id
  and p.priority is not null
  and c.priority is null;

alter table public.marketplace_profiles
  drop column if exists priority;

-- -----------------------------------------------------------------------------
-- Saving a marketplace, without a priority of its own
--
-- Dropped and recreated: the signature changes, and an overload differing by
-- one argument is what PostgREST would then have to guess between.
-- -----------------------------------------------------------------------------

drop function if exists public.update_marketplace(
  uuid, boolean, boolean, text, text, text, text, date, text, text, text, numeric, numeric,
  text, text, text[], text[], text, boolean, text, text[], text[], text
);

create function public.update_marketplace(
  p_company_id        uuid,
  p_sells             boolean default null,
  p_sources           boolean default null,
  p_store_name        text    default null,
  p_seller_account_id text    default null,
  p_store_url         text    default null,
  p_account_status    text    default null,
  p_opened_on         date    default null,
  p_settlement_terms  text    default null,
  p_payout_method     text    default null,
  p_payout_currency   text    default null,
  p_reserve_percent   numeric default null,
  p_minimum_lot_value numeric default null,
  p_notes             text    default null,
  p_fee_notes         text    default null,
  p_marketplace_type  text[]  default null,
  p_fulfilment        text[]  default null,
  p_payment           text    default null,
  p_buyers_premium    boolean default null,
  p_selling_cost      text    default null,
  p_audience          text[]  default null,
  p_inventory_type    text[]  default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.current_org_id();
  v_row public.marketplace_profiles%rowtype;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow changing records';
  end if;

  select * into v_row from public.marketplace_profiles
  where company_id = p_company_id and organization_id = v_org
  for update;

  if not found then
    raise exception 'Marketplace not found';
  end if;

  if coalesce(p_sells, v_row.sells_through) is false
     and coalesce(p_sources, v_row.sources_from) is false then
    raise exception 'A marketplace has to be one you sell through, source from, or both';
  end if;

  update public.marketplace_profiles set
    sells_through     = coalesce(p_sells, v_row.sells_through),
    sources_from      = coalesce(p_sources, v_row.sources_from),
    store_name        = public.blank_or(p_store_name, v_row.store_name),
    seller_account_id = public.blank_or(p_seller_account_id, v_row.seller_account_id),
    store_url         = public.blank_or(p_store_url, v_row.store_url),
    account_status    = public.blank_or(p_account_status, v_row.account_status),
    opened_on         = coalesce(p_opened_on, v_row.opened_on),
    settlement_terms  = public.blank_or(p_settlement_terms, v_row.settlement_terms),
    payout_method     = public.blank_or(p_payout_method, v_row.payout_method),
    payout_currency   = upper(public.blank_or(p_payout_currency, v_row.payout_currency)),
    reserve_percent   = coalesce(p_reserve_percent, v_row.reserve_percent),
    minimum_lot_value = coalesce(p_minimum_lot_value, v_row.minimum_lot_value),
    notes             = public.blank_or(p_notes, v_row.notes),
    fee_notes         = public.blank_or(p_fee_notes, v_row.fee_notes),
    marketplace_type  = coalesce(p_marketplace_type, v_row.marketplace_type),
    fulfilment        = coalesce(p_fulfilment, v_row.fulfilment),
    payment           = public.blank_or(p_payment, v_row.payment),
    /* The one field where null is a real answer — nobody has looked it up — so
       it is written every time rather than following the null-leaves-it rule. */
    buyers_premium    = p_buyers_premium,
    selling_cost      = public.blank_or(p_selling_cost, v_row.selling_cost),
    audience          = coalesce(p_audience, v_row.audience),
    inventory_type    = coalesce(p_inventory_type, v_row.inventory_type)
  where company_id = p_company_id;
end;
$$;

revoke execute on function public.update_marketplace(
  uuid, boolean, boolean, text, text, text, text, date, text, text, text, numeric, numeric,
  text, text, text[], text[], text, boolean, text, text[], text[]
) from public, anon;

grant execute on function public.update_marketplace(
  uuid, boolean, boolean, text, text, text, text, date, text, text, text, numeric, numeric,
  text, text, text[], text[], text, boolean, text, text[], text[]
) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Changing it across a selection
--
-- Recreated from the live definition with one line changed — the list of
-- company columns bulk_update_records will accept. Rebuilding it from memory is
-- how a function quietly loses its security mode; this is a copy with 'priority'
-- added beside 'owner_id' and 'hidden'.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bulk_update_records(p_entity text, p_ids uuid[], p_field text, p_mode text, p_values text[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org    uuid := public.current_org_id();
  v_table  text;
  v_kind   text;
  v_key    text;
  v_type   text;
  v_values text[] := coalesce(p_values, '{}');
  v_count  integer;
begin
  if v_org is null then
    raise exception 'No organization in context';
  end if;

  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  if array_length(p_ids, 1) > 500 then
    raise exception 'Too many records in one change (limit 500)';
  end if;

  if p_mode not in ('set', 'add', 'remove', 'clear') then
    raise exception 'Unknown change %', p_mode;
  end if;

  v_table := case p_entity
    when 'contact' then 'contacts'
    when 'company' then 'companies'
    else null
  end;

  if v_table is null then
    raise exception 'Cannot bulk edit %', p_entity;
  end if;

  if p_field like 'custom_fields.%' then
    v_key := substring(p_field from 15);

    if not exists (
      select 1 from public.custom_field_definitions
      where organization_id = v_org
        and entity_type::text = p_entity
        and key = v_key
    ) then
      raise exception 'No such field %', v_key;
    end if;

    v_kind := 'json';
  elsif p_entity = 'contact' and p_field in
    ('owner_id', 'company_id', 'lifecycle_stage', 'priority', 'credibility', 'hidden', 'mailable_override')
  then
    v_kind := 'scalar';
  elsif p_entity = 'contact' and p_field = 'role_type' then
    v_kind := 'array';
  elsif p_entity = 'company' and p_field in ('owner_id', 'hidden', 'priority') then
    v_kind := 'scalar';
  elsif p_entity = 'company' and p_field in ('specialty_market', 'customer_type') then
    v_kind := 'array';
  else
    raise exception 'Field % cannot be changed in bulk', p_field;
  end if;

  if v_kind = 'scalar' then
    select format_type(a.atttypid, a.atttypmod)
    into v_type
    from pg_attribute a
    where a.attrelid = format('public.%I', v_table)::regclass
      and a.attname = p_field
      and a.attnum > 0;

    execute format(
      'update public.%I set %I = nullif($1, '''')::%s
       where id = any($2) and organization_id = $3',
      v_table, p_field, v_type
    )
    using case when p_mode = 'clear' then '' else coalesce(v_values[1], '') end, p_ids, v_org;

  elsif v_kind = 'array' then
    if p_mode = 'clear' then
      execute format(
        'update public.%I set %I = ''{}''::text[]
         where id = any($1) and organization_id = $2',
        v_table, p_field
      ) using p_ids, v_org;

    elsif p_mode = 'set' then
      execute format(
        'update public.%I set %I = $1
         where id = any($2) and organization_id = $3',
        v_table, p_field
      ) using v_values, p_ids, v_org;

    elsif p_mode = 'add' then
      execute format(
        'update public.%I set %I = coalesce(%I, ''{}'') || (
           select coalesce(array_agg(v), ''{}'')
           from unnest($1) v
           where not (v = any(coalesce(%I, ''{}'')))
         )
         where id = any($2) and organization_id = $3',
        v_table, p_field, p_field, p_field
      ) using v_values, p_ids, v_org;

    else
      execute format(
        'update public.%I set %I = (
           select coalesce(array_agg(v), ''{}'')
           from unnest(coalesce(%I, ''{}'')) v
           where not (v = any($1))
         )
         where id = any($2) and organization_id = $3',
        v_table, p_field, p_field
      ) using v_values, p_ids, v_org;
    end if;

  else
    if p_mode = 'clear' then
      execute format(
        'update public.%I set custom_fields = coalesce(custom_fields, ''{}''::jsonb) - $1
         where id = any($2) and organization_id = $3',
        v_table
      ) using v_key, p_ids, v_org;

    elsif p_mode = 'set' then
      execute format(
        'update public.%I
         set custom_fields = jsonb_set(coalesce(custom_fields, ''{}''::jsonb), array[$1], $2, true)
         where id = any($3) and organization_id = $4',
        v_table
      ) using
        v_key,
        case
          when array_length(v_values, 1) is null then '""'::jsonb
          when array_length(v_values, 1) = 1 then to_jsonb(v_values[1])
          else to_jsonb(v_values)
        end,
        p_ids,
        v_org;

    else
      raise exception 'A custom field can only be set or cleared, not %', p_mode;
    end if;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end
$function$;
