-- =============================================================================
-- Three retirements and a rename
--
-- The custom Region field, the Sources from column, and the state the company
-- priority list was left in by 20260247.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The custom Region field
--
-- The other Region. 20260250 dropped based_in_region, which was the built-in
-- subdivision; this is the one an organization defined for itself, matched by
-- name because there is no id to hold on to.
--
-- No application change goes with this. The deal ledger asks regionFieldKey()
-- which field to slice by and drops its Region column when the answer is
-- nothing, and the list columns read the same lookup — so removing the field is
-- the whole of it. That is the shape it was built in, and it is being taken at
-- its word rather than tested by hoping.
--
-- Multi-tenant, so the column definitions stay in the code: another
-- organization may still keep a region field, and this deletes rows rather than
-- capability.
-- -----------------------------------------------------------------------------

do $$
declare
  v_field record;
begin
  for v_field in
    select id, organization_id, key
    from public.custom_field_definitions
    where entity_type = 'company'
      and (btrim(label) ~* '^regions?$' or btrim(key) ~* '^regions?$')
  loop
    -- The stored answers go with the question. Left behind, they are unreachable
    -- json that a later field of the same name would silently inherit.
    update public.companies
    set custom_fields = custom_fields - v_field.key
    where organization_id = v_field.organization_id
      and custom_fields ? v_field.key;

    delete from public.field_options
    where organization_id = v_field.organization_id
      and entity_type = 'company'
      and field_key = v_field.key;

    delete from public.custom_field_definitions where id = v_field.id;

    raise notice 'Region: removed the company field %', v_field.key;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Sources from
--
-- Where a company buys, which turned out to be a question nobody asked of this
-- book. sells_in stays; the two were built as a pair and only one of them
-- earned its place.
-- -----------------------------------------------------------------------------

alter table public.companies drop column if exists sources_in;

-- The trigger validated both territories. Recreated from its current definition
-- with sources_in taken out of the normalisation and the check, and nothing
-- else touched — the t(code) alias below is load-bearing and stays verbatim.
create or replace function public.companies_normalise_geography()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_unknown text;
begin
  new.based_in := nullif(upper(btrim(coalesce(new.based_in, ''))), '');

  new.sells_in := public.normalise_territory(new.sells_in);

  -- Named rather than counted: "MX is not a country code" is a message somebody
  -- can act on; "invalid territory" is not.
  -- t(code), not `as code`: with the bare alias, `code` inside the correlated
  -- subquery resolves to countries.code rather than the unnested value, the
  -- comparison becomes c.code = c.code, and the check silently passes
  -- everything. The test that inserts "North America" is what found it.
  select t.code into v_unknown
  from unnest(new.sells_in) as t(code)
  where not exists (select 1 from public.countries c where c.code = t.code)
  limit 1;

  if v_unknown is not null then
    raise exception '% is not a country or region code. Territories use ISO 3166-1 alpha-2, like CA, US or MX, or one of the trading regions.', v_unknown;
  end if;

  return new;
end;
$$;

revoke execute on function public.companies_normalise_geography() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Priority: Standard becomes Medium, and the list stops repeating itself
--
-- 20260247 gave companies a priority list two ways: it seeded Critical / High /
-- Standard / Low, and then copied whatever the organization already used on
-- contacts. Both inserts say `on conflict do nothing`, and the unique key is
-- (organization, entity, field, value) — so the two agree only where the words
-- match exactly. An organization that had renamed its contact list, or that
-- differed by so much as a capital letter, ended up holding both sets.
--
-- Deduplicating on lower(btrim(value)) is what actually undoes that: it catches
-- "standard" against "Standard" and " High" against "High", which the unique
-- key by construction cannot. The survivor is the one with the lowest order, so
-- the list keeps the sequence somebody arranged rather than an arbitrary row.
-- -----------------------------------------------------------------------------

-- Rename first, so a pre-existing "Medium" and a renamed "Standard" collide
-- here and are merged by the deduplication below rather than failing the
-- unique key.
update public.field_options
set value = 'Medium'
where field_key = 'priority' and btrim(value) ~* '^standard$'
  and not exists (
    select 1 from public.field_options other
    where other.organization_id = field_options.organization_id
      and other.entity_type = field_options.entity_type
      and other.field_key = 'priority'
      and btrim(other.value) ~* '^medium$'
  );

-- The ones that could not be renamed because Medium was already there.
delete from public.field_options
where field_key = 'priority' and btrim(value) ~* '^standard$';

-- The records themselves. A stored priority is the word, not a reference, so
-- renaming the option without this leaves rows pointing at a value that is no
-- longer on the list.
update public.contacts set priority = 'Medium' where btrim(priority) ~* '^standard$';
update public.companies set priority = 'Medium' where btrim(priority) ~* '^standard$';

-- Near-duplicates, whatever produced them.
delete from public.field_options dup
using public.field_options keep
where dup.field_key = 'priority'
  and keep.field_key = 'priority'
  and dup.organization_id = keep.organization_id
  and dup.entity_type = keep.entity_type
  and lower(btrim(dup.value)) = lower(btrim(keep.value))
  and (keep."order", keep.id) < (dup."order", dup.id);
