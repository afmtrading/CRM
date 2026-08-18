-- =============================================================================
-- Base Country, Sells To, and the end of the subdivision
--
-- Three changes to how a company says where it is and where it trades.
--
-- 1. The nine trading regions join the country list, at the top of it. A desk
--    that sells "across Europe" should be able to say so without picking one
--    country and meaning another, and the answer to "where do you sell" is
--    sometimes a region and sometimes a country. One list holds both.
--
-- 2. The Country field that lived on the contact moves onto the company. It was
--    always a fact about the business — everybody at one company is in the same
--    country — and companies.based_in has existed for that since 20260238.
--
-- 3. based_in_region goes. It held an ISO 3166-2 subdivision, which turned out
--    to be a finer grain than anybody files a buyer at; with regions now in the
--    country list, the question it answered is asked and answered above it.
--
-- Renaming "Based in" to "Base Country" and "Sells in" to "Sells To" is a
-- labelling change and lives in the application, not here. The columns keep
-- their names: a column is addressed by code, and renaming it would be churn
-- across a dozen files to change a word nobody reads.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Regions in the country list
--
-- The codes come from the X series, which ISO 3166-1 sets aside as
-- user-assigned and will never issue to a country. That is what makes it safe
-- to put these in the same table and behind the same foreign key: based_in
-- still references countries, sells_in is still checked against countries, and
-- neither had to learn about a second kind of place.
--
-- `kind` is what keeps them apart where it matters — a report that wants only
-- real countries can still ask for them.
-- -----------------------------------------------------------------------------

alter table public.countries
  add column if not exists kind text not null default 'country'
    check (kind in ('country', 'region')),
  -- Regions first, in the order they were asked for; every country after, by
  -- name. One column so a list only has to order by two things.
  add column if not exists sort_order integer not null default 100;

comment on column public.countries.kind is
  'country = an ISO 3166-1 entry. region = a trading bloc, coded from the ISO user-assigned X series so it can live in the same list and behind the same foreign key.';

insert into public.countries (code, name, kind, sort_order) values
  ('XN', 'North America',            'region', 1),
  ('XS', 'Central & South America',  'region', 2),
  ('XE', 'Europe',                   'region', 3),
  ('XM', 'MENA',                     'region', 4),
  ('XF', 'Central & South Africa',   'region', 5),
  ('XA', 'East Asia',                'region', 6),
  ('XB', 'South Asia',               'region', 7),
  ('XC', 'Southeast Asia',           'region', 8),
  ('XO', 'Oceania',                  'region', 9)
on conflict (code) do update
  set name = excluded.name, kind = excluded.kind, sort_order = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- The contact's Country becomes the company's
--
-- Organization-defined, so it is found by name rather than by id — the same
-- forgiving match findCompanyField uses in the application, and for the same
-- reason: an admin who deleted the field and made it again left no id to hold.
--
-- Only where the company has no country yet. A value typed against the business
-- itself is better evidence than one typed against somebody who works there,
-- and this must not overwrite it.
--
-- Where two contacts at one company disagree, the most common answer wins and
-- ties break alphabetically, so the result does not depend on row order.
-- -----------------------------------------------------------------------------

do $$
declare
  v_field record;
  v_moved integer;
begin
  for v_field in
    select id, organization_id, key
    from public.custom_field_definitions
    where entity_type = 'contact'
      and (lower(btrim(label)) = 'country' or lower(btrim(key)) = 'country')
  loop
    with answers as (
      select
        c.company_id,
        btrim(c.custom_fields ->> v_field.key) as answer,
        count(*) as votes
      from public.contacts c
      where c.organization_id = v_field.organization_id
        and c.company_id is not null
        and c.deleted_at is null
        and nullif(btrim(coalesce(c.custom_fields ->> v_field.key, '')), '') is not null
      group by 1, 2
    ),
    winner as (
      select distinct on (company_id) company_id, answer
      from answers
      order by company_id, votes desc, answer
    )
    update public.companies co
    set based_in = ref.code
    from winner w
    join public.countries ref
      -- The stored answer is whatever somebody typed into a select: usually the
      -- country's name, sometimes already its code.
      on lower(ref.name) = lower(w.answer) or upper(ref.code) = upper(w.answer)
    where co.id = w.company_id
      and co.organization_id = v_field.organization_id
      and co.based_in is null
      and ref.kind = 'country';

    get diagnostics v_moved = row_count;
    raise notice 'Base Country: filled % companies from the contact field %', v_moved, v_field.key;

    -- The field goes, and its option list with it. Leaving a retired field
    -- behind is how a form ends up with two boxes asking the same question.
    delete from public.field_options
    where organization_id = v_field.organization_id
      and entity_type = 'contact'
      and field_key = v_field.key;

    delete from public.custom_field_definitions where id = v_field.id;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- The subdivision goes
--
-- The trigger is recreated from its current definition with the two
-- based_in_region blocks removed and nothing else touched. The territory check
-- below it is the part that matters and is copied verbatim, comments included —
-- it is the one that a test caught silently passing everything.
-- -----------------------------------------------------------------------------

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
  new.sources_in := public.normalise_territory(new.sources_in);

  -- Named rather than counted: "MX is not a country code" is a message somebody
  -- can act on; "invalid territory" is not.
  -- t(code), not `as code`: with the bare alias, `code` inside the correlated
  -- subquery resolves to countries.code rather than the unnested value, the
  -- comparison becomes c.code = c.code, and the check silently passes
  -- everything. The test that inserts "North America" is what found it.
  select t.code into v_unknown
  from unnest(new.sells_in || new.sources_in) as t(code)
  where not exists (select 1 from public.countries c where c.code = t.code)
  limit 1;

  if v_unknown is not null then
    raise exception '% is not a country or region code. Territories use ISO 3166-1 alpha-2, like CA, US or MX, or one of the trading regions.', v_unknown;
  end if;

  return new;
end;
$$;

revoke execute on function public.companies_normalise_geography() from public, anon, authenticated;

alter table public.companies drop column if exists based_in_region;

-- Nothing reads it now. A reference table with no referent is a table somebody
-- will eventually wire back up by accident.
drop table if exists public.country_subdivisions;
