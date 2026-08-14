-- =============================================================================
-- Where a company is, and where it trades
--
-- THE QUERY THIS EXISTS FOR
--
--   "buyers who sell their products only in Canada"
--   "buyers based in Canada who sell in Canada and the USA"
--   "buyers who sell in the USA and also in Mexico"
--
-- None of those could be asked before. A company had `addresses` — a JSON blob
-- of free text — and nothing at all about territory. So the answer lived in
-- nobody's database and in somebody's head.
--
-- TWO DIMENSIONS, NOT ONE
--
-- Where a company *is* and where it *sells* are different facts, and the second
-- one is the interesting one. A distributor in Ontario selling across North
-- America and a distributor in Ontario selling only province-wide are not the
-- same prospect, and until now they were indistinguishable.
--
-- This is not a theory about how the business might want to slice its data. The
-- spreadsheets already carry it: a real import file has 51 rows whose region
-- column reads "QC - Montreal / North America", "ON - Niagara / national",
-- "BC - Burnaby / national". Somebody was keeping both facts in one string with
-- a slash, because there was nowhere else to put them.
--
-- WHY THESE ARE NOT ORGANIZATION-CONFIGURABLE OPTION LISTS
--
-- Every other classification here — market, company type, priority — is a list
-- the organization edits, because those are its own vocabulary. Countries are
-- not. They are a fact about the world, and a list somebody can edit is a list
-- that eventually contains "USA", "U.S.A." and "United States" as three
-- separate values — at which point "sells in the USA" quietly returns a third
-- of the answer and nobody notices.
--
-- So countries come from ISO 3166 and are validated against it. The
-- organization cannot add "North America" as a country, which is the point.
--
-- WHY THE ARRAYS ARE SORTED
--
-- "sells in exactly Canada and the USA" is an equality test on an array, and in
-- Postgres {CA,US} <> {US,CA}. Sorting and de-duplicating on write makes the
-- obvious query work and makes two identical territories compare equal. The
-- trigger below is what guarantees it, so no caller has to remember.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The reference data
--
-- Global, not per organization: ISO 3166 does not vary by customer. No RLS
-- policy either — every signed-in user may read it, and nobody may write it.
-- -----------------------------------------------------------------------------
create table if not exists public.countries (
  code text primary key check (code ~ '^[A-Z]{2}$'),
  name text not null
);

create table if not exists public.country_subdivisions (
  /** ISO 3166-2, e.g. CA-QC. */
  code         text primary key check (code ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
  country_code text not null references public.countries (code) on delete cascade,
  name         text not null
);

create index if not exists country_subdivisions_country_idx
  on public.country_subdivisions (country_code);

comment on table public.countries is
  'ISO 3166-1 alpha-2. Reference data, shared by every organization, read-only to the app.';
comment on table public.country_subdivisions is
  'ISO 3166-2. Seeded for Canada and the United States; add others as they are needed.';

insert into public.countries (code, name) values
  ('AD', 'Andorra'),
  ('AE', 'United Arab Emirates'),
  ('AF', 'Afghanistan'),
  ('AG', 'Antigua and Barbuda'),
  ('AI', 'Anguilla'),
  ('AL', 'Albania'),
  ('AM', 'Armenia'),
  ('AO', 'Angola'),
  ('AQ', 'Antarctica'),
  ('AR', 'Argentina'),
  ('AS', 'American Samoa'),
  ('AT', 'Austria'),
  ('AU', 'Australia'),
  ('AW', 'Aruba'),
  ('AX', 'Åland Islands'),
  ('AZ', 'Azerbaijan'),
  ('BA', 'Bosnia and Herzegovina'),
  ('BB', 'Barbados'),
  ('BD', 'Bangladesh'),
  ('BE', 'Belgium'),
  ('BF', 'Burkina Faso'),
  ('BG', 'Bulgaria'),
  ('BH', 'Bahrain'),
  ('BI', 'Burundi'),
  ('BJ', 'Benin'),
  ('BL', 'Saint Barthélemy'),
  ('BM', 'Bermuda'),
  ('BN', 'Brunei Darussalam'),
  ('BO', 'Bolivia'),
  ('BQ', 'Bonaire, Sint Eustatius and Saba'),
  ('BR', 'Brazil'),
  ('BS', 'Bahamas'),
  ('BT', 'Bhutan'),
  ('BV', 'Bouvet Island'),
  ('BW', 'Botswana'),
  ('BY', 'Belarus'),
  ('BZ', 'Belize'),
  ('CA', 'Canada'),
  ('CC', 'Cocos (Keeling) Islands'),
  ('CD', 'Congo, Democratic Republic of the'),
  ('CF', 'Central African Republic'),
  ('CG', 'Congo'),
  ('CH', 'Switzerland'),
  ('CI', 'Côte d''Ivoire'),
  ('CK', 'Cook Islands'),
  ('CL', 'Chile'),
  ('CM', 'Cameroon'),
  ('CN', 'China'),
  ('CO', 'Colombia'),
  ('CR', 'Costa Rica'),
  ('CU', 'Cuba'),
  ('CV', 'Cabo Verde'),
  ('CW', 'Curaçao'),
  ('CX', 'Christmas Island'),
  ('CY', 'Cyprus'),
  ('CZ', 'Czechia'),
  ('DE', 'Germany'),
  ('DJ', 'Djibouti'),
  ('DK', 'Denmark'),
  ('DM', 'Dominica'),
  ('DO', 'Dominican Republic'),
  ('DZ', 'Algeria'),
  ('EC', 'Ecuador'),
  ('EE', 'Estonia'),
  ('EG', 'Egypt'),
  ('EH', 'Western Sahara'),
  ('ER', 'Eritrea'),
  ('ES', 'Spain'),
  ('ET', 'Ethiopia'),
  ('FI', 'Finland'),
  ('FJ', 'Fiji'),
  ('FK', 'Falkland Islands'),
  ('FM', 'Micronesia'),
  ('FO', 'Faroe Islands'),
  ('FR', 'France'),
  ('GA', 'Gabon'),
  ('GB', 'United Kingdom'),
  ('GD', 'Grenada'),
  ('GE', 'Georgia'),
  ('GF', 'French Guiana'),
  ('GG', 'Guernsey'),
  ('GH', 'Ghana'),
  ('GI', 'Gibraltar'),
  ('GL', 'Greenland'),
  ('GM', 'Gambia'),
  ('GN', 'Guinea'),
  ('GP', 'Guadeloupe'),
  ('GQ', 'Equatorial Guinea'),
  ('GR', 'Greece'),
  ('GS', 'South Georgia and the South Sandwich Islands'),
  ('GT', 'Guatemala'),
  ('GU', 'Guam'),
  ('GW', 'Guinea-Bissau'),
  ('GY', 'Guyana'),
  ('HK', 'Hong Kong'),
  ('HM', 'Heard Island and McDonald Islands'),
  ('HN', 'Honduras'),
  ('HR', 'Croatia'),
  ('HT', 'Haiti'),
  ('HU', 'Hungary'),
  ('ID', 'Indonesia'),
  ('IE', 'Ireland'),
  ('IL', 'Israel'),
  ('IM', 'Isle of Man'),
  ('IN', 'India'),
  ('IO', 'British Indian Ocean Territory'),
  ('IQ', 'Iraq'),
  ('IR', 'Iran'),
  ('IS', 'Iceland'),
  ('IT', 'Italy'),
  ('JE', 'Jersey'),
  ('JM', 'Jamaica'),
  ('JO', 'Jordan'),
  ('JP', 'Japan'),
  ('KE', 'Kenya'),
  ('KG', 'Kyrgyzstan'),
  ('KH', 'Cambodia'),
  ('KI', 'Kiribati'),
  ('KM', 'Comoros'),
  ('KN', 'Saint Kitts and Nevis'),
  ('KP', 'Korea, Democratic People''s Republic of'),
  ('KR', 'Korea, Republic of'),
  ('KW', 'Kuwait'),
  ('KY', 'Cayman Islands'),
  ('KZ', 'Kazakhstan'),
  ('LA', 'Lao People''s Democratic Republic'),
  ('LB', 'Lebanon'),
  ('LC', 'Saint Lucia'),
  ('LI', 'Liechtenstein'),
  ('LK', 'Sri Lanka'),
  ('LR', 'Liberia'),
  ('LS', 'Lesotho'),
  ('LT', 'Lithuania'),
  ('LU', 'Luxembourg'),
  ('LV', 'Latvia'),
  ('LY', 'Libya'),
  ('MA', 'Morocco'),
  ('MC', 'Monaco'),
  ('MD', 'Moldova'),
  ('ME', 'Montenegro'),
  ('MF', 'Saint Martin (French part)'),
  ('MG', 'Madagascar'),
  ('MH', 'Marshall Islands'),
  ('MK', 'North Macedonia'),
  ('ML', 'Mali'),
  ('MM', 'Myanmar'),
  ('MN', 'Mongolia'),
  ('MO', 'Macao'),
  ('MP', 'Northern Mariana Islands'),
  ('MQ', 'Martinique'),
  ('MR', 'Mauritania'),
  ('MS', 'Montserrat'),
  ('MT', 'Malta'),
  ('MU', 'Mauritius'),
  ('MV', 'Maldives'),
  ('MW', 'Malawi'),
  ('MX', 'Mexico'),
  ('MY', 'Malaysia'),
  ('MZ', 'Mozambique'),
  ('NA', 'Namibia'),
  ('NC', 'New Caledonia'),
  ('NE', 'Niger'),
  ('NF', 'Norfolk Island'),
  ('NG', 'Nigeria'),
  ('NI', 'Nicaragua'),
  ('NL', 'Netherlands'),
  ('NO', 'Norway'),
  ('NP', 'Nepal'),
  ('NR', 'Nauru'),
  ('NU', 'Niue'),
  ('NZ', 'New Zealand'),
  ('OM', 'Oman'),
  ('PA', 'Panama'),
  ('PE', 'Peru'),
  ('PF', 'French Polynesia'),
  ('PG', 'Papua New Guinea'),
  ('PH', 'Philippines'),
  ('PK', 'Pakistan'),
  ('PL', 'Poland'),
  ('PM', 'Saint Pierre and Miquelon'),
  ('PN', 'Pitcairn'),
  ('PR', 'Puerto Rico'),
  ('PS', 'Palestine, State of'),
  ('PT', 'Portugal'),
  ('PW', 'Palau'),
  ('PY', 'Paraguay'),
  ('QA', 'Qatar'),
  ('RE', 'Réunion'),
  ('RO', 'Romania'),
  ('RS', 'Serbia'),
  ('RU', 'Russian Federation'),
  ('RW', 'Rwanda'),
  ('SA', 'Saudi Arabia'),
  ('SB', 'Solomon Islands'),
  ('SC', 'Seychelles'),
  ('SD', 'Sudan'),
  ('SE', 'Sweden'),
  ('SG', 'Singapore'),
  ('SH', 'Saint Helena, Ascension and Tristan da Cunha'),
  ('SI', 'Slovenia'),
  ('SJ', 'Svalbard and Jan Mayen'),
  ('SK', 'Slovakia'),
  ('SL', 'Sierra Leone'),
  ('SM', 'San Marino'),
  ('SN', 'Senegal'),
  ('SO', 'Somalia'),
  ('SR', 'Suriname'),
  ('SS', 'South Sudan'),
  ('ST', 'Sao Tome and Principe'),
  ('SV', 'El Salvador'),
  ('SX', 'Sint Maarten (Dutch part)'),
  ('SY', 'Syrian Arab Republic'),
  ('SZ', 'Eswatini'),
  ('TC', 'Turks and Caicos Islands'),
  ('TD', 'Chad'),
  ('TF', 'French Southern Territories'),
  ('TG', 'Togo'),
  ('TH', 'Thailand'),
  ('TJ', 'Tajikistan'),
  ('TK', 'Tokelau'),
  ('TL', 'Timor-Leste'),
  ('TM', 'Turkmenistan'),
  ('TN', 'Tunisia'),
  ('TO', 'Tonga'),
  ('TR', 'Türkiye'),
  ('TT', 'Trinidad and Tobago'),
  ('TV', 'Tuvalu'),
  ('TW', 'Taiwan'),
  ('TZ', 'Tanzania'),
  ('UA', 'Ukraine'),
  ('UG', 'Uganda'),
  ('UM', 'United States Minor Outlying Islands'),
  ('US', 'United States'),
  ('UY', 'Uruguay'),
  ('UZ', 'Uzbekistan'),
  ('VA', 'Holy See'),
  ('VC', 'Saint Vincent and the Grenadines'),
  ('VE', 'Venezuela'),
  ('VG', 'Virgin Islands (British)'),
  ('VI', 'Virgin Islands (U.S.)'),
  ('VN', 'Viet Nam'),
  ('VU', 'Vanuatu'),
  ('WF', 'Wallis and Futuna'),
  ('WS', 'Samoa'),
  ('YE', 'Yemen'),
  ('YT', 'Mayotte'),
  ('ZA', 'South Africa'),
  ('ZM', 'Zambia'),
  ('ZW', 'Zimbabwe')
on conflict (code) do update set name = excluded.name;

insert into public.country_subdivisions (code, country_code, name) values
  ('CA-AB', 'CA', 'Alberta'),
  ('CA-BC', 'CA', 'British Columbia'),
  ('CA-MB', 'CA', 'Manitoba'),
  ('CA-NB', 'CA', 'New Brunswick'),
  ('CA-NL', 'CA', 'Newfoundland and Labrador'),
  ('CA-NS', 'CA', 'Nova Scotia'),
  ('CA-NT', 'CA', 'Northwest Territories'),
  ('CA-NU', 'CA', 'Nunavut'),
  ('CA-ON', 'CA', 'Ontario'),
  ('CA-PE', 'CA', 'Prince Edward Island'),
  ('CA-QC', 'CA', 'Quebec'),
  ('CA-SK', 'CA', 'Saskatchewan'),
  ('CA-YT', 'CA', 'Yukon'),
  ('US-AL', 'US', 'Alabama'),
  ('US-AK', 'US', 'Alaska'),
  ('US-AZ', 'US', 'Arizona'),
  ('US-AR', 'US', 'Arkansas'),
  ('US-CA', 'US', 'California'),
  ('US-CO', 'US', 'Colorado'),
  ('US-CT', 'US', 'Connecticut'),
  ('US-DE', 'US', 'Delaware'),
  ('US-DC', 'US', 'District of Columbia'),
  ('US-FL', 'US', 'Florida'),
  ('US-GA', 'US', 'Georgia'),
  ('US-HI', 'US', 'Hawaii'),
  ('US-ID', 'US', 'Idaho'),
  ('US-IL', 'US', 'Illinois'),
  ('US-IN', 'US', 'Indiana'),
  ('US-IA', 'US', 'Iowa'),
  ('US-KS', 'US', 'Kansas'),
  ('US-KY', 'US', 'Kentucky'),
  ('US-LA', 'US', 'Louisiana'),
  ('US-ME', 'US', 'Maine'),
  ('US-MD', 'US', 'Maryland'),
  ('US-MA', 'US', 'Massachusetts'),
  ('US-MI', 'US', 'Michigan'),
  ('US-MN', 'US', 'Minnesota'),
  ('US-MS', 'US', 'Mississippi'),
  ('US-MO', 'US', 'Missouri'),
  ('US-MT', 'US', 'Montana'),
  ('US-NE', 'US', 'Nebraska'),
  ('US-NV', 'US', 'Nevada'),
  ('US-NH', 'US', 'New Hampshire'),
  ('US-NJ', 'US', 'New Jersey'),
  ('US-NM', 'US', 'New Mexico'),
  ('US-NY', 'US', 'New York'),
  ('US-NC', 'US', 'North Carolina'),
  ('US-ND', 'US', 'North Dakota'),
  ('US-OH', 'US', 'Ohio'),
  ('US-OK', 'US', 'Oklahoma'),
  ('US-OR', 'US', 'Oregon'),
  ('US-PA', 'US', 'Pennsylvania'),
  ('US-RI', 'US', 'Rhode Island'),
  ('US-SC', 'US', 'South Carolina'),
  ('US-SD', 'US', 'South Dakota'),
  ('US-TN', 'US', 'Tennessee'),
  ('US-TX', 'US', 'Texas'),
  ('US-UT', 'US', 'Utah'),
  ('US-VT', 'US', 'Vermont'),
  ('US-VA', 'US', 'Virginia'),
  ('US-WA', 'US', 'Washington'),
  ('US-WV', 'US', 'West Virginia'),
  ('US-WI', 'US', 'Wisconsin'),
  ('US-WY', 'US', 'Wyoming')
on conflict (code) do update set name = excluded.name;

grant select on public.countries to authenticated, anon, service_role;
grant select on public.country_subdivisions to authenticated, anon, service_role;

-- -----------------------------------------------------------------------------
-- The three facts about a company
--
-- On the company rather than the contact, and that is not a guess: in the real
-- import file every company that appears more than once agrees with itself on
-- country and region. What disagreed between its rows was the buyer type, which
-- turned out to be describing the row rather than the business. Geography is a
-- property of the firm; the people who work there inherit it.
-- -----------------------------------------------------------------------------
alter table public.companies
  /** Where the company is. ISO 3166-1 alpha-2. */
  add column if not exists based_in text references public.countries (code),
  /** The state or province within it, when known. ISO 3166-2. */
  add column if not exists based_in_region text references public.country_subdivisions (code),
  /** Where they sell. Sorted and de-duplicated by trigger — see below. */
  add column if not exists sells_in text[] not null default '{}',
  /** Where they buy or source from. */
  add column if not exists sources_in text[] not null default '{}';

comment on column public.companies.based_in is
  'Where the company operates from. Separate from sells_in on purpose: being in Ontario and selling across North America are different facts.';
comment on column public.companies.sells_in is
  'Countries they sell into. Always sorted and de-duplicated, so equality means "exactly these".';
comment on column public.companies.sources_in is
  'Countries they buy or source from. Sorted and de-duplicated, as sells_in.';

-- Both territory columns are searched with array containment, which is what GIN
-- is for. Partial, because most companies will have neither filled in at first
-- and an index over thousands of empty arrays earns nothing.
create index if not exists companies_sells_in_idx
  on public.companies using gin (sells_in) where cardinality(sells_in) > 0;
create index if not exists companies_sources_in_idx
  on public.companies using gin (sources_in) where cardinality(sources_in) > 0;
create index if not exists companies_based_in_idx
  on public.companies (organization_id, based_in) where based_in is not null;

-- -----------------------------------------------------------------------------
-- Normalising a territory
--
-- Upper-cased, trimmed, blanks dropped, de-duplicated, sorted, and every code
-- checked against ISO 3166. Sorting is the load-bearing part: it is what makes
--
--   where sells_in = array['CA','US']
--
-- mean "exactly Canada and the USA" rather than "exactly Canada and the USA, in
-- that order, if you happened to type them that way".
--
-- Written as one immutable function so the trigger and any backfill agree.
-- -----------------------------------------------------------------------------
create or replace function public.normalise_territory(p_codes text[])
returns text[]
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(
    (select array_agg(distinct upper(btrim(code)) order by upper(btrim(code)))
     from unnest(coalesce(p_codes, '{}')) as code
     where btrim(code) <> ''),
    '{}');
$$;

comment on function public.normalise_territory(text[]) is
  'Upper-cases, trims, de-duplicates and sorts a list of country codes. Sorting is what makes equality mean "exactly these".';

create or replace function public.companies_normalise_geography()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_unknown text;
begin
  new.based_in := nullif(upper(btrim(coalesce(new.based_in, ''))), '');
  new.based_in_region := nullif(upper(btrim(coalesce(new.based_in_region, ''))), '');

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
    raise exception '% is not a country code. Territories use ISO 3166-1 alpha-2, like CA, US or MX.', v_unknown;
  end if;

  -- A region has to be in the country it claims to be in. Without this,
  -- "based in Mexico, region CA-QC" is storable and reads as a data entry
  -- success.
  if new.based_in_region is not null then
    if new.based_in is null then
      new.based_in := split_part(new.based_in_region, '-', 1);
    elsif split_part(new.based_in_region, '-', 1) <> new.based_in then
      raise exception '% is not in %.', new.based_in_region, new.based_in;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists companies_geography on public.companies;
create trigger companies_geography
  before insert or update on public.companies
  for each row execute function public.companies_normalise_geography();

revoke execute on function public.companies_normalise_geography() from public, anon, authenticated;
revoke execute on function public.normalise_territory(text[]) from public, anon;
grant execute on function public.normalise_territory(text[]) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Stock types
--
-- A second option list beside Merchandise, because the two answer different
-- questions. "Medical" and "Apparel" say what somebody deals in; "Overstock"
-- and "Customer returns" say what condition it arrives in. A buyer of medical
-- overstock and a buyer of medical customer returns are not the same call, and
-- one list holding both values cannot tell them apart.
--
-- Seeded from what a real import file actually contained.
-- -----------------------------------------------------------------------------
insert into public.field_options (organization_id, entity_type, field_key, value, color, "order")
select o.id, 'company', 'stock_type', v.value, v.color, v.ord
from public.organizations o
cross join (values
  ('Overstock',        'blue',   1),
  ('Customer returns', 'amber',  2),
  ('Surplus',          'teal',   3),
  ('Shelf pulls',      'violet', 4),
  ('Closeouts',        'rose',   5),
  ('Refurbished',      'slate',  6)
) as v(value, color, ord)
on conflict do nothing;

alter table public.companies
  add column if not exists stock_type text[] not null default '{}';

comment on column public.companies.stock_type is
  'What condition of goods they deal in — overstock, customer returns, shelf pulls. Separate from merchandise, which is what category.';

create index if not exists companies_stock_type_idx
  on public.companies using gin (stock_type) where cardinality(stock_type) > 0;

-- And for organizations created from here on. seed_field_options is rebuilt
-- from its own definition rather than retyped, so the twenty-odd lists it
-- already seeds cannot be lost to a transcription slip.
do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'seed_field_options';

  if v_def is null then
    raise exception 'seed_field_options is missing — run the earlier migrations first';
  end if;

  if position('stock_type' in v_def) > 0 then
    return;
  end if;

  v_def := replace(v_def,
    '(''company'', ''customer_type'',    ''Distributor'',    ''blue'',   1),',
    '(''company'', ''stock_type'',       ''Overstock'',        ''blue'',   1),
    (''company'', ''stock_type'',       ''Customer returns'', ''amber'',  2),
    (''company'', ''stock_type'',       ''Surplus'',          ''teal'',   3),
    (''company'', ''stock_type'',       ''Shelf pulls'',      ''violet'', 4),
    (''company'', ''stock_type'',       ''Closeouts'',        ''rose'',   5),
    (''company'', ''stock_type'',       ''Refurbished'',      ''slate'',  6),

    (''company'', ''customer_type'',    ''Distributor'',    ''blue'',   1),');

  if position('stock_type' in v_def) = 0 then
    raise exception 'Could not find the seed list to extend';
  end if;

  execute v_def;
end;
$$;
