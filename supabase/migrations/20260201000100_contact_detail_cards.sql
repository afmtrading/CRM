-- =============================================================================
-- Contact detail cards
--
-- Rebuilds the contact record around five cards — Contact details, Influence,
-- Additional info, Digital, and Update history — and gives an organization
-- control over the option lists behind the select fields, including each
-- option's colour.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- New contact columns
--
-- `phone` is kept as-is and presented as the mobile number: duplicate detection
-- already matches on it, so repurposing the column would quietly change which
-- records are treated as duplicates.
-- -----------------------------------------------------------------------------
alter table contacts
  add column if not exists job_title        text,
  add column if not exists office_phone     text,
  add column if not exists specialty_market text[] not null default '{}'::text[],
  add column if not exists customer_type    text[] not null default '{}'::text[],
  add column if not exists role_type        text[] not null default '{}'::text[],
  add column if not exists priority         text,
  add column if not exists credibility      text,
  add column if not exists birthday         date,
  -- Markdown, not HTML. Stored notes are rendered back into the page, and
  -- markdown can be escaped before formatting; storing HTML would mean either
  -- trusting the input or writing a sanitiser.
  add column if not exists notes            text,
  add column if not exists website          text,
  add column if not exists facebook         text,
  add column if not exists instagram        text,
  add column if not exists tiktok           text,
  add column if not exists x_twitter        text,
  -- Free-form extra links: [{ "label": "Catalogue", "url": "https://…" }]
  add column if not exists links            jsonb not null default '[]'::jsonb,
  add column if not exists created_by       uuid references users (id) on delete set null,
  add column if not exists updated_by       uuid references users (id) on delete set null;

create index if not exists contacts_birthday_idx on contacts (organization_id, birthday);

-- -----------------------------------------------------------------------------
-- Which card a custom field appears on
-- -----------------------------------------------------------------------------
alter table custom_field_definitions
  add column if not exists card text not null default 'additional';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'custom_field_definitions_card_check'
  ) then
    alter table custom_field_definitions
      add constraint custom_field_definitions_card_check
      check (card in ('details', 'influence', 'additional', 'digital'));
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Option lists for the select fields
--
-- An organization edits these without a deploy (PRD 6.5's rule: configuration
-- belongs to the admin, not the codebase). Colour is a name from a fixed
-- palette rather than a hex value, because the UI maps it onto Tailwind classes
-- that have to exist at build time.
-- -----------------------------------------------------------------------------
create table if not exists field_options (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  field_key       text not null,
  value           text not null,
  color           text not null default 'slate',
  "order"         integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (organization_id, field_key, value)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'field_options_color_check') then
    alter table field_options add constraint field_options_color_check
      check (color in ('slate', 'blue', 'green', 'amber', 'red', 'violet', 'cyan', 'rose', 'orange', 'teal'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'field_options_field_key_check') then
    alter table field_options add constraint field_options_field_key_check
      check (field_key in ('specialty_market', 'customer_type', 'role_type', 'priority', 'credibility'));
  end if;
end
$$;

create index if not exists field_options_lookup_idx
  on field_options (organization_id, field_key, "order");

-- The base migration's `grant on all tables` only covered the tables that
-- existed then, so a table added later has to grant for itself.
revoke all on field_options from anon;
grant select, insert, update, delete on field_options to authenticated;

alter table field_options enable row level security;
alter table field_options force row level security;

drop policy if exists field_options_read on field_options;
create policy field_options_read on field_options
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists field_options_write on field_options;
create policy field_options_write on field_options
  for all to authenticated
  using (organization_id = public.current_org_id())
  with check (organization_id = public.current_org_id());

-- -----------------------------------------------------------------------------
-- Starting option lists
--
-- Deliberately generic: these are a starting point an admin is expected to
-- rewrite for their own market, not a fixed taxonomy.
-- -----------------------------------------------------------------------------
create or replace function seed_field_options(p_organization_id uuid)
returns void
language sql
as $$
  insert into field_options (organization_id, field_key, value, color, "order")
  select p_organization_id, d.field_key, d.value, d.color, d.ord
  from (values
    ('specialty_market', 'Foodservice',    'blue',   1),
    ('specialty_market', 'Retail',         'green',  2),
    ('specialty_market', 'Wholesale',      'violet', 3),
    ('specialty_market', 'Industrial',     'orange', 4),
    ('specialty_market', 'Export',         'cyan',   5),

    ('customer_type',    'Distributor',    'blue',   1),
    ('customer_type',    'Broker',         'violet', 2),
    ('customer_type',    'Manufacturer',   'teal',   3),
    ('customer_type',    'Retailer',       'green',  4),
    ('customer_type',    'End user',       'slate',  5),

    ('role_type',        'Decision maker', 'green',  1),
    ('role_type',        'Influencer',     'blue',   2),
    ('role_type',        'Champion',       'violet', 3),
    ('role_type',        'Gatekeeper',     'amber',  4),
    ('role_type',        'Technical buyer','cyan',   5),
    ('role_type',        'End user',       'slate',  6),

    ('priority',         'Low',            'slate',  1),
    ('priority',         'Standard',       'blue',   2),
    ('priority',         'High',           'amber',  3),
    ('priority',         'Critical',       'red',    4),

    ('credibility',      'Unverified',     'slate',  1),
    ('credibility',      'Developing',     'amber',  2),
    ('credibility',      'Trusted',        'green',  3),
    ('credibility',      'Highly trusted', 'teal',   4)
  ) as d(field_key, value, color, ord)
  on conflict (organization_id, field_key, value) do nothing;
$$;

select seed_field_options(id) from organizations;

create or replace function organizations_seed_field_options()
returns trigger
language plpgsql
as $$
begin
  perform seed_field_options(new.id);
  return new;
end;
$$;

drop trigger if exists organizations_seed_field_options on organizations;
create trigger organizations_seed_field_options
  after insert on organizations
  for each row execute function organizations_seed_field_options();

-- -----------------------------------------------------------------------------
-- Created by / updated by
--
-- Stamped by a trigger rather than by the application, so the record is right
-- no matter which path wrote it — form, import, or API.
-- -----------------------------------------------------------------------------
create or replace function stamp_contact_actor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
begin
  select id into v_actor
  from public.users
  where auth_provider_id = auth.uid()
    and organization_id = new.organization_id
  limit 1;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, v_actor);
    new.updated_by := coalesce(new.updated_by, v_actor);
  else
    -- Left alone when there is no session (a background job, or SQL run by
    -- hand), so an automated write cannot erase who last touched the record.
    new.updated_by := coalesce(v_actor, old.updated_by);
  end if;

  return new;
end;
$$;

drop trigger if exists contacts_stamp_actor on contacts;
create trigger contacts_stamp_actor
  before insert or update on contacts
  for each row execute function stamp_contact_actor();

-- -----------------------------------------------------------------------------
-- Birthday reminders
--
-- Creates a task three days before a contact's birthday, owned by whoever owns
-- the contact. Idempotent through the existing (organization, external_source,
-- external_id) unique constraint, so running it twice in a day — or twice in a
-- year — produces one task.
--
-- Call it from a scheduled job: `select create_birthday_reminders();` daily, or
-- POST /api/reminders/birthdays.
-- -----------------------------------------------------------------------------
create or replace function create_birthday_reminders(p_days_ahead integer default 3)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created integer;
begin
  with due as (
    select
      c.id,
      c.organization_id,
      c.owner_id,
      trim(both ' ' from coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) as name,
      -- This year's occurrence, rolled forward if it has already passed, so the
      -- comparison works across a year boundary.
      (
        case
          when make_date(
                 extract(year from current_date)::int,
                 extract(month from c.birthday)::int,
                 extract(day from c.birthday)::int
               ) >= current_date
          then make_date(
                 extract(year from current_date)::int,
                 extract(month from c.birthday)::int,
                 extract(day from c.birthday)::int
               )
          else make_date(
                 extract(year from current_date)::int + 1,
                 extract(month from c.birthday)::int,
                 extract(day from c.birthday)::int
               )
        end
      ) as next_birthday
    from contacts c
    where c.birthday is not null
      and c.duplicate_of_id is null
  )
  insert into activities (
    organization_id, type, related_to_type, related_to_id, owner_id,
    subject, body, due_date, external_source, external_id, occurred_at
  )
  select
    due.organization_id,
    'task',
    'contact',
    due.id,
    due.owner_id,
    'Birthday: ' || coalesce(nullif(due.name, ''), 'contact'),
    'Birthday on ' || to_char(due.next_birthday, 'FMMonth FMDD') || '.',
    due.next_birthday::timestamptz,
    'birthday',
    due.id::text || '-' || extract(year from due.next_birthday)::text,
    now()
  from due
  where due.next_birthday - current_date = p_days_ahead
  on conflict (organization_id, external_source, external_id) do nothing;

  get diagnostics v_created = row_count;
  return v_created;
end;
$$;

comment on function create_birthday_reminders is
  'Creates a task p_days_ahead before each contact birthday. Idempotent; run daily from a scheduled job.';

grant execute on function public.create_birthday_reminders(integer) to authenticated, service_role;
grant execute on function public.seed_field_options(uuid) to service_role;
