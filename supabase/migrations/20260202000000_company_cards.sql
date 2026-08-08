-- =============================================================================
-- Company detail cards
--
-- Gives a company the same card treatment a contact has, and moves the two
-- fields that describe a business rather than a person — specialty market and
-- customer type — off the contact and onto the company where they belong.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- LinkedIn, on both records
-- -----------------------------------------------------------------------------
alter table contacts  add column if not exists linkedin text;
alter table companies add column if not exists linkedin text;

-- -----------------------------------------------------------------------------
-- Company columns
-- -----------------------------------------------------------------------------
alter table companies
  add column if not exists phone            text,
  add column if not exists email            text,
  add column if not exists notes            text,
  add column if not exists specialty_market text[] not null default '{}'::text[],
  add column if not exists customer_type    text[] not null default '{}'::text[],
  add column if not exists facebook         text,
  add column if not exists instagram        text,
  add column if not exists tiktok           text,
  add column if not exists x_twitter        text,
  -- [{ "label": "TikTok Shop", "url": "https://…" }]
  add column if not exists links            jsonb not null default '[]'::jsonb,
  -- [{ "label": "Head office", "address": "…" }]
  add column if not exists addresses        jsonb not null default '[]'::jsonb,
  add column if not exists created_by       uuid references users (id) on delete set null,
  add column if not exists updated_by       uuid references users (id) on delete set null;

-- -----------------------------------------------------------------------------
-- Move specialty market and customer type from contact to company
--
-- Rolled up first: a company inherits the distinct values its contacts were
-- carrying, so nothing is lost on the way across. Values on a contact with no
-- company have nowhere to go and are dropped with the column.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'contacts' and column_name = 'specialty_market'
  ) then
    update companies co
    set specialty_market = coalesce(
      (select array_agg(distinct v) from contacts c, unnest(c.specialty_market) v
       where c.company_id = co.id),
      '{}'::text[]
    );

    update companies co
    set customer_type = coalesce(
      (select array_agg(distinct v) from contacts c, unnest(c.customer_type) v
       where c.company_id = co.id),
      '{}'::text[]
    );

    alter table contacts drop column specialty_market;
    alter table contacts drop column customer_type;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Tags on companies
--
-- Mirrors contact_tags, including the guard that a tag and the record it is
-- attached to have to belong to the same organization.
-- -----------------------------------------------------------------------------
create table if not exists company_tags (
  organization_id uuid not null references organizations (id) on delete cascade,
  company_id      uuid not null references companies (id) on delete cascade,
  tag_id          uuid not null references tags (id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (company_id, tag_id)
);

create index if not exists company_tags_tag_idx on company_tags (organization_id, tag_id);

revoke all on company_tags from anon;
grant select, insert, update, delete on company_tags to authenticated;

alter table company_tags enable row level security;
alter table company_tags force row level security;

drop policy if exists company_tags_read on company_tags;
create policy company_tags_read on company_tags
  for select to authenticated
  using (organization_id = public.current_org_id());

drop policy if exists company_tags_write on company_tags;
create policy company_tags_write on company_tags
  for all to authenticated
  using (organization_id = public.current_org_id())
  with check (organization_id = public.current_org_id());

create or replace function company_tags_sync_organization()
returns trigger
language plpgsql
as $$
declare
  v_company_org uuid;
  v_tag_org     uuid;
begin
  select organization_id into v_company_org from companies where id = new.company_id;
  select organization_id into v_tag_org     from tags      where id = new.tag_id;

  if v_company_org is null or v_tag_org is null or v_company_org <> v_tag_org then
    raise exception 'company and tag must belong to the same organization';
  end if;

  new.organization_id = v_company_org;
  return new;
end;
$$;

drop trigger if exists company_tags_sync_organization on company_tags;
create trigger company_tags_sync_organization
  before insert or update on company_tags
  for each row execute function company_tags_sync_organization();

-- -----------------------------------------------------------------------------
-- Created by / updated by on companies
--
-- Same trigger body as contacts: resolves the signed-in person and leaves the
-- stamp alone when there is no session, so a background write cannot erase who
-- last touched the record.
-- -----------------------------------------------------------------------------
create or replace function stamp_company_actor()
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
    new.updated_by := coalesce(v_actor, old.updated_by);
  end if;

  return new;
end;
$$;

drop trigger if exists companies_stamp_actor on companies;
create trigger companies_stamp_actor
  before insert or update on companies
  for each row execute function stamp_company_actor();

-- -----------------------------------------------------------------------------
-- Merging a contact must not orphan its tags — the contact merge function
-- already moves contact_tags; company_tags are untouched by it, so nothing to
-- change there. Recorded here so the omission reads as deliberate.
-- -----------------------------------------------------------------------------
