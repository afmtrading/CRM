-- Data integrity: what reading the code cannot tell you.
--
-- The migrations decide what the schema allows. This asks what the data
-- actually says — a stored value with no option row behind it, an owner id
-- pointing at nobody, a contact the importer left without a name. None of it
-- is a constraint violation; all of it reaches a screen looking wrong.
--
-- Read-only. Safe to run against production.
--
--   psql "$DATABASE_URL" -f supabase/checks/data-integrity.sql
--
-- or paste it into the Supabase SQL editor. Every check returns nothing when
-- the data is clean, so an empty result is the pass.
--
-- Every comparison is scoped by organization_id. Two organizations each having
-- an option called "New", or a company called Acme, is the system working —
-- matching on the value alone reports the whole seeded vocabulary as duplicated.
--
-- Two faults are deliberately not checked, because the schema already refuses
-- them and a check that cannot fire is worse than no check — it reads as
-- coverage:
--
--   an owner id with no user behind it   contacts_owner_id_fkey
--   one option value in two spellings    field_options_value_unique
--
-- Both were tried against a scratch database and rejected by the constraint.
-- If either constraint is ever dropped, the check belongs back here.

with

-- Live records only. A soft-deleted contact in the recycle bin and a merged-away
-- tombstone are both meant to look abandoned.
live_contacts as (
  select * from contacts where deleted_at is null and duplicate_of_id is null
),
live_companies as (
  select * from companies where deleted_at is null
),
-- Neither of these carries a duplicate_of_id: only contacts are merged, so
-- soft deletion is the whole of what makes one of these abandoned.
live_products as (
  select * from products where deleted_at is null
),
live_deals as (
  select * from deals where deleted_at is null
),

-- One row per stored value that no option list accounts for. The screens look
-- options up by (organization, entity_type, field_key, value); anything missing
-- here renders as an uncoloured chip or as raw text.
contact_scalar_orphans as (
  select 'contact' as entity, v.key as field, v.value, count(*) as rows
  from (
    select c.organization_id, 'priority' as key, c.priority as value from live_contacts c
    union all
    select c.organization_id, 'credibility', c.credibility from live_contacts c
  ) v
  where v.value is not null and v.value <> ''
    and not exists (
      select 1 from field_options o
      where o.organization_id = v.organization_id
        and o.entity_type = 'contact'
        and o.field_key = v.key
        and lower(o.value) = lower(v.value)
    )
  group by v.key, v.value
),

contact_array_orphans as (
  select 'contact' as entity, 'role_type' as field, v as value, count(*) as rows
  from live_contacts c, unnest(c.role_type) v
  where not exists (
    select 1 from field_options o
    where o.organization_id = c.organization_id
      and o.entity_type = 'contact'
      and o.field_key = 'role_type'
      and lower(o.value) = lower(v)
  )
  group by v
),

company_scalar_orphans as (
  select 'company' as entity, 'priority' as field, co.priority as value, count(*) as rows
  from live_companies co
  where co.priority is not null and co.priority <> ''
    and not exists (
      select 1 from field_options o
      where o.organization_id = co.organization_id
        and o.entity_type = 'company'
        and o.field_key = 'priority'
        and lower(o.value) = lower(co.priority)
    )
  group by co.priority
),

-- The three option-backed lists a company stores on its own row. The
-- marketplace lists are option-backed too, but they live on
-- marketplace_profiles, so marketplace_orphans below reads them instead of this
-- growing a fourth branch. product_orphans and deal_orphans cover the rest.
company_array_orphans as (
  select 'company' as entity, x.key as field, x.v as value, count(*) as rows
  from (
    select co.organization_id, 'customer_type' as key, unnest(co.customer_type) as v
    from live_companies co
    union all
    select co.organization_id, 'specialty_market', unnest(co.specialty_market)
    from live_companies co
    union all
    select co.organization_id, 'stock_type', unnest(co.stock_type)
    from live_companies co
  ) x
  where not exists (
    select 1 from field_options o
    where o.organization_id = x.organization_id
      and o.entity_type = 'company'
      and o.field_key = x.key
      and lower(o.value) = lower(x.v)
  )
  group by x.key, x.v
),

-- The seven lists a marketplace draws on. The values sit on marketplace_profiles
-- while the options are the company's — entity_type is 'company' for every one
-- of these keys, because a marketplace is a company with a profile attached and
-- not a record type of its own.
--
-- Reported as 'marketplace' regardless. The company is where the row lives, but
-- the marketplace page is where the value looks wrong and the page somebody has
-- to open to put it right.
--
-- Read through live_companies because a profile has no deleted_at of its own:
-- soft-delete the company and its marketplace leaves the list with it, so a
-- value on one is as abandoned as the record holding it.
--
-- The key on the left of each pair is the field_options field_key and the one
-- on the right is the column, and they are not the same word — account_status
-- is stored under marketplace_account_status, fulfilment under
-- marketplace_fulfilment. src/lib/marketplace.ts holds the same mapping for the
-- screens; these two have to agree.
marketplace_values as (
  select mp.organization_id, k.key, k.v
  from marketplace_profiles mp
  join live_companies co on co.id = mp.company_id
  cross join lateral (
    select 'marketplace_type' as key, v from unnest(mp.marketplace_type) v
    union all select 'marketplace_fulfilment',     v from unnest(mp.fulfilment) v
    union all select 'marketplace_audience',       v from unnest(mp.audience) v
    union all select 'marketplace_inventory_type', v from unnest(mp.inventory_type) v
    union all select 'marketplace_payment',        mp.payment
    union all select 'marketplace_selling_cost',   mp.selling_cost
    union all select 'marketplace_account_status', mp.account_status
  ) k(key, v)
),

marketplace_orphans as (
  select 'marketplace' as entity, x.key as field, x.v as value, count(*) as rows
  from marketplace_values x
  where x.v is not null and x.v <> ''
    and not exists (
      select 1 from field_options o
      where o.organization_id = x.organization_id
        and o.entity_type = 'company'
        and o.field_key = x.key
        and lower(o.value) = lower(x.v)
    )
  group by x.key, x.v
),

-- A product's five lists. Two of the keys are not the column they are stored
-- in: a category lives in `category` under the key product_category, and a
-- status in `status` under product_status, while type, condition and priority
-- match. product-form.tsx pairs them the same way for the screens.
--
-- Getting either of those backwards does not fail quietly here the way it would
-- on a marketplace — production holds real values for four of the five, so a
-- mismatched key reports every one of them as an orphan on the next run.
product_orphans as (
  select 'product' as entity, x.key as field, x.v as value, count(*) as rows
  from live_products p
  cross join lateral (values
    ('product_category',  p.category),
    ('product_type',      p.product_type),
    ('product_condition', p.product_condition),
    ('product_status',    p.status),
    ('priority',          p.priority)
  ) x(key, v)
  where x.v is not null and x.v <> ''
    and not exists (
      select 1 from field_options o
      where o.organization_id = p.organization_id
        and o.entity_type = 'product'
        and o.field_key = x.key
        and lower(o.value) = lower(x.v)
    )
  group by x.key, x.v
),

-- Why a deal was lost, which is the only list a deal draws on. Its status is an
-- enum and belongs in the header's list of faults the schema already refuses,
-- not here.
deal_orphans as (
  select 'deal' as entity, 'loss_reason' as field, d.loss_reason as value, count(*) as rows
  from live_deals d
  where d.loss_reason is not null and d.loss_reason <> ''
    and not exists (
      select 1 from field_options o
      where o.organization_id = d.organization_id
        and o.entity_type = 'deal'
        and o.field_key = 'loss_reason'
        and lower(o.value) = lower(d.loss_reason)
    )
  group by d.loss_reason
),

-- A custom field's value outlives its definition: the jsonb keeps the key and
-- nothing renders it. Invisible until somebody asks why a column went blank.
contact_custom_orphans as (
  select 'contact' as entity, k as field, '(custom field, no definition)' as value, count(*) as rows
  from live_contacts c, jsonb_object_keys(coalesce(c.custom_fields, '{}'::jsonb)) k
  where not exists (
    select 1 from custom_field_definitions d
    where d.organization_id = c.organization_id
      and d.entity_type = 'contact'
      and d.key = k
  )
  group by k
),

company_custom_orphans as (
  select 'company' as entity, k as field, '(custom field, no definition)' as value, count(*) as rows
  from live_companies co, jsonb_object_keys(coalesce(co.custom_fields, '{}'::jsonb)) k
  where not exists (
    select 1 from custom_field_definitions d
    where d.organization_id = co.organization_id
      and d.entity_type = 'company'
      and d.key = k
  )
  group by k
),

-- Owner is drawn by looking the id up in a list of users the page loaded for
-- this organization, so an owner from another organization renders as "—" —
-- indistinguishable from unassigned, while the record is in fact spoken for.
--
-- Only the cross-tenant half is worth asking: contacts_owner_id_fkey already
-- makes an id with no user behind it impossible.
cross_tenant_owners as (
  select 'contact' as entity, 'owner_id' as field, c.owner_id::text as value, count(*) as rows
  from live_contacts c
  where c.owner_id is not null
    and not exists (
      select 1 from users u
      where u.id = c.owner_id and u.organization_id = c.organization_id
    )
  group by c.owner_id
  union all
  select 'company', 'owner_id', co.owner_id::text, count(*)
  from live_companies co
  where co.owner_id is not null
    and not exists (
      select 1 from users u
      where u.id = co.owner_id and u.organization_id = co.organization_id
    )
  group by co.owner_id
),

-- A contact whose company belongs to somebody else, which the joins on both
-- record pages would follow.
crossed_companies as (
  select 'contact' as entity, 'company_id' as field, c.id::text as value, 1 as rows
  from live_contacts c
  join companies co on co.id = c.company_id
  where co.organization_id <> c.organization_id
),

-- The importer builds a name from whatever columns it matched. A row where it
-- matched neither is a contact nobody can find by name.
nameless as (
  select 'contact' as entity, 'name' as field, '(no first or last name)' as value, count(*) as rows
  from live_contacts c
  where coalesce(nullif(trim(c.first_name), ''), nullif(trim(c.last_name), '')) is null
  having count(*) > 0
),

-- A contact nobody can open a conversation with. LinkedIn counts as a way
-- through: a lead captured from a profile before anyone has sourced an email is
-- prospecting in progress, not a defective row, and a check that flags it
-- teaches the reader to skip the check.
--
-- The remaining ways to reach a contact — website, facebook, instagram,
-- x_twitter and the links array — are still not counted. Widen this the same
-- way if one of them turns out to be how somebody is actually being worked.
unreachable as (
  select 'contact' as entity, 'email/phone/linkedin' as field,
         '(no email, phone or LinkedIn)' as value, count(*) as rows
  from live_contacts c
  where coalesce(
    nullif(trim(c.email), ''),
    nullif(trim(c.phone), ''),
    nullif(trim(c.office_phone), ''),
    nullif(trim(c.linkedin), '')
  ) is null
  having count(*) > 0
),

-- Not a constraint: two live contacts may legitimately share an address. Worth
-- seeing, because it is usually an import that ran twice.
duplicate_emails as (
  select 'contact' as entity, 'email' as field, lower(trim(c.email)) as value, count(*) as rows
  from live_contacts c
  where nullif(trim(c.email), '') is not null
  group by c.organization_id, lower(trim(c.email))
  having count(*) > 1
),

duplicate_companies as (
  select 'company' as entity, 'name' as field, lower(trim(co.name)) as value, count(*) as rows
  from live_companies co
  group by co.organization_id, lower(trim(co.name))
  having count(*) > 1
),

-- Tenancy on the join tables, which carry their own organization_id kept in
-- step by a trigger. A row whose halves disagree is one organization's tag on
-- another's record.
tag_leaks as (
  select 'contact' as entity, 'contact_tags' as field, ct.contact_id::text as value, count(*) as rows
  from contact_tags ct
  join contacts c on c.id = ct.contact_id
  join tags t on t.id = ct.tag_id
  where c.organization_id <> t.organization_id
  group by ct.contact_id
  union all
  select 'company', 'company_tags', cot.company_id::text, count(*)
  from company_tags cot
  join companies co on co.id = cot.company_id
  join tags t on t.id = cot.tag_id
  where co.organization_id <> t.organization_id
  group by cot.company_id
)

select * from (
  select * from contact_scalar_orphans
  union all select * from contact_array_orphans
  union all select * from company_scalar_orphans
  union all select * from company_array_orphans
  union all select * from marketplace_orphans
  union all select * from product_orphans
  union all select * from deal_orphans
  union all select * from contact_custom_orphans
  union all select * from company_custom_orphans
  union all select * from cross_tenant_owners
  union all select * from crossed_companies
  union all select * from nameless
  union all select * from unreachable
  union all select * from duplicate_emails
  union all select * from duplicate_companies
  union all select * from tag_leaks
) findings
order by entity, field, rows desc, value;
