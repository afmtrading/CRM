-- =============================================================================
-- FLO CRM — Phase 1 schema (PRD Section 5)
--
-- Every tenant-owned table carries organization_id. Row-level security is
-- applied in a separate migration (20260101000100_rls.sql) so that the tenancy
-- backstop is reviewable on its own.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type org_status          as enum ('active', 'inactive');
create type user_role           as enum ('admin', 'regular');
create type user_status         as enum ('active', 'invited', 'disabled');
create type lifecycle_stage     as enum ('lead', 'qualified', 'customer', 'other');
create type deal_status         as enum ('open', 'won', 'lost');
create type activity_type       as enum ('call', 'email', 'meeting', 'note', 'task');
create type related_to_type     as enum ('contact', 'company', 'deal');
create type import_status       as enum ('pending', 'processing', 'complete', 'failed');
create type filter_entity_type  as enum ('contact', 'company', 'deal', 'campaign');
create type score_condition     as enum ('equals', 'not_equals', 'contains', 'is_filled', 'is_empty', 'greater_than', 'less_than');
create type assignment_strategy as enum ('round_robin', 'by_source', 'fixed_user');
create type custom_field_type   as enum ('text', 'number', 'date', 'boolean', 'select');

-- -----------------------------------------------------------------------------
-- 5.1 Organization
-- -----------------------------------------------------------------------------
create table organizations (
  id               uuid primary key default gen_random_uuid(),
  name             text        not null,
  slug             text        not null unique,
  status           org_status  not null default 'active',
  -- Phase 3 (8.8) fields, additive and harmless in Phase 1.
  logo_url         text,
  primary_color    text        not null default '#0f766e',
  default_currency text        not null default 'CAD',
  created_at       timestamptz not null default now()
);

comment on table organizations is 'Tenant root. Every other tenant table references this by organization_id.';

-- -----------------------------------------------------------------------------
-- 5.2 User
--
-- Deviation from the PRD table: auth_provider_id is uuid (referencing
-- auth.users.id) rather than a bare string, so the RLS predicate can join on
-- auth.uid() without a cast. It still holds exactly the Supabase Auth user ID.
--
-- A person who belongs to more than one organization gets one row per
-- organization; that is what makes Phase 3's org switching additive.
-- -----------------------------------------------------------------------------
create table users (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid        not null references organizations (id) on delete cascade,
  email            text        not null,
  name             text        not null default '',
  role             user_role   not null default 'regular',
  auth_provider_id uuid        references auth.users (id) on delete set null,
  status           user_status not null default 'invited',
  last_login_at    timestamptz,
  created_at       timestamptz not null default now(),
  unique (organization_id, email),
  unique (organization_id, auth_provider_id)
);

create index users_auth_provider_id_idx on users (auth_provider_id);
create index users_email_idx on users (lower(email));

-- -----------------------------------------------------------------------------
-- 5.4 Company (Account) — declared before Contact because Contact references it
-- -----------------------------------------------------------------------------
create table companies (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name            text not null,
  domain          text,
  industry        text,
  owner_id        uuid references users (id) on delete set null,
  custom_fields   jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index companies_org_idx on companies (organization_id);
create index companies_org_name_idx on companies (organization_id, lower(name));
create index companies_owner_idx on companies (organization_id, owner_id);
create index companies_custom_fields_idx on companies using gin (custom_fields);

-- -----------------------------------------------------------------------------
-- 5.3 Contact
--
-- Lead is a lifecycle_stage here, not a separate table (PRD 5.3 design note).
-- -----------------------------------------------------------------------------
create table contacts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  first_name      text not null default '',
  last_name       text not null default '',
  email           text,
  phone           text,
  company_id      uuid references companies (id) on delete set null,
  owner_id        uuid references users (id) on delete set null,
  lifecycle_stage lifecycle_stage not null default 'lead',
  source          text,
  custom_fields   jsonb not null default '{}'::jsonb,
  lead_score      integer not null default 0,
  duplicate_of_id uuid references contacts (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index contacts_org_idx on contacts (organization_id);
create index contacts_org_email_idx on contacts (organization_id, lower(email));
create index contacts_org_name_idx on contacts (organization_id, lower(last_name), lower(first_name));
create index contacts_owner_idx on contacts (organization_id, owner_id);
create index contacts_company_idx on contacts (organization_id, company_id);
create index contacts_lifecycle_idx on contacts (organization_id, lifecycle_stage);
create index contacts_custom_fields_idx on contacts using gin (custom_fields);

-- Merged-away contacts keep their row (duplicate_of_id points at the survivor)
-- so old links still resolve; active list views filter them out.
create index contacts_active_idx on contacts (organization_id) where duplicate_of_id is null;

-- -----------------------------------------------------------------------------
-- 5.5 Pipeline / 5.6 Stage
-- -----------------------------------------------------------------------------
create table pipelines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name            text not null,
  is_default      boolean not null default false,
  created_at      timestamptz not null default now()
);

create index pipelines_org_idx on pipelines (organization_id);
create unique index pipelines_one_default_per_org on pipelines (organization_id) where is_default;

create table stages (
  id                  uuid primary key default gen_random_uuid(),
  -- organization_id is denormalised onto Stage (the PRD table lists only
  -- pipeline_id) so the RLS predicate is identical on every table and does not
  -- need a join through pipelines. Kept in sync by a trigger below.
  organization_id     uuid not null references organizations (id) on delete cascade,
  pipeline_id         uuid not null references pipelines (id) on delete cascade,
  name                text not null,
  "order"             integer not null default 0,
  default_probability numeric(4, 3) not null default 0.500
    check (default_probability >= 0 and default_probability <= 1),
  created_at          timestamptz not null default now()
);

create index stages_pipeline_idx on stages (pipeline_id, "order");
create index stages_org_idx on stages (organization_id);

-- -----------------------------------------------------------------------------
-- 5.7 Deal
-- -----------------------------------------------------------------------------
create table deals (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references organizations (id) on delete cascade,
  name                   text not null,
  contact_id             uuid references contacts (id) on delete set null,
  company_id             uuid references companies (id) on delete set null,
  stage_id               uuid not null references stages (id) on delete restrict,
  value                  numeric(14, 2) not null default 0,
  currency               text not null default 'CAD',
  probability            numeric(4, 3) not null default 0.500
    check (probability >= 0 and probability <= 1),
  -- Acceptance criterion 6.3: a stage move resets probability to the new
  -- stage's default *unless the user overrode it*. This flag is that "unless".
  probability_overridden boolean not null default false,
  expected_close_date    date,
  actual_close_date      date,
  status                 deal_status not null default 'open',
  owner_id               uuid references users (id) on delete set null,
  position               integer not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index deals_org_idx on deals (organization_id);
create index deals_stage_idx on deals (organization_id, stage_id, position);
create index deals_owner_idx on deals (organization_id, owner_id);
create index deals_contact_idx on deals (organization_id, contact_id);
create index deals_company_idx on deals (organization_id, company_id);
create index deals_status_idx on deals (organization_id, status);

-- -----------------------------------------------------------------------------
-- 5.8 Activity
-- -----------------------------------------------------------------------------
create table activities (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  type            activity_type not null,
  related_to_type related_to_type not null,
  related_to_id   uuid not null,
  owner_id        uuid references users (id) on delete set null,
  subject         text not null default '',
  body            text,
  due_date        timestamptz,
  completed_at    timestamptz,
  -- Provenance for 6.4's mailbox/calendar sync: null for hand-logged records,
  -- otherwise the external message/event id, so a re-sync is idempotent.
  external_source text,
  external_id     text,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique (organization_id, external_source, external_id)
);

create index activities_org_idx on activities (organization_id);
create index activities_related_idx on activities (organization_id, related_to_type, related_to_id, occurred_at desc);
create index activities_owner_due_idx on activities (organization_id, owner_id, due_date)
  where completed_at is null;

-- -----------------------------------------------------------------------------
-- 5.9 Tag / ContactTag
-- -----------------------------------------------------------------------------
create table tags (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name            text not null,
  color           text not null default '#64748b',
  created_at      timestamptz not null default now()
);

-- Tag names are unique per organization, case-insensitively. Expression
-- uniqueness has to be an index, not an inline table constraint.
create unique index tags_org_name_idx on tags (organization_id, lower(name));

create table contact_tags (
  organization_id uuid not null references organizations (id) on delete cascade,
  contact_id      uuid not null references contacts (id) on delete cascade,
  tag_id          uuid not null references tags (id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (contact_id, tag_id)
);

create index contact_tags_tag_idx on contact_tags (organization_id, tag_id);

-- -----------------------------------------------------------------------------
-- 5.10 SavedFilter
-- -----------------------------------------------------------------------------
create table saved_filters (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id         uuid references users (id) on delete cascade,
  entity_type     filter_entity_type not null default 'contact',
  name            text not null,
  filter_json     jsonb not null default '{}'::jsonb,
  is_shared       boolean not null default false,
  created_at      timestamptz not null default now()
);

create index saved_filters_lookup_idx on saved_filters (organization_id, entity_type);

-- -----------------------------------------------------------------------------
-- 5.11 ImportJob
-- -----------------------------------------------------------------------------
create table import_jobs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id         uuid references users (id) on delete set null,
  entity_type     filter_entity_type not null default 'contact',
  status          import_status not null default 'pending',
  file_name       text not null default '',
  field_mapping   jsonb not null default '{}'::jsonb,
  options         jsonb not null default '{}'::jsonb,
  rows_processed  integer not null default 0,
  rows_failed     integer not null default 0,
  -- Per-row failures, so an import reports which rows failed and why instead of
  -- failing the batch silently (acceptance criterion 6.7).
  errors          jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index import_jobs_org_idx on import_jobs (organization_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 5.12 LeadScoreRule
-- -----------------------------------------------------------------------------
create table lead_score_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  field           text not null,
  condition       score_condition not null,
  value           text,
  points          integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

create index lead_score_rules_org_idx on lead_score_rules (organization_id) where is_active;

-- -----------------------------------------------------------------------------
-- Assignment / routing rules (6.5)
-- -----------------------------------------------------------------------------
create table assignment_rules (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations (id) on delete cascade,
  name              text not null,
  strategy          assignment_strategy not null default 'round_robin',
  -- 'by_source' matches this value against contact.source; ignored otherwise.
  source_match      text,
  fixed_user_id     uuid references users (id) on delete cascade,
  -- Round-robin cursor: the user_id handed out last.
  last_assigned_id  uuid references users (id) on delete set null,
  priority          integer not null default 0,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);

create index assignment_rules_org_idx on assignment_rules (organization_id, priority) where is_active;

-- -----------------------------------------------------------------------------
-- Custom field definitions
--
-- custom_fields on Contact/Company is free-form JSON per the PRD. This table
-- describes the keys an organization has agreed on, so the UI can render inputs
-- and 6.6's filter builder can offer custom fields as filterable columns.
-- -----------------------------------------------------------------------------
create table custom_field_definitions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  entity_type     filter_entity_type not null default 'contact',
  key             text not null,
  label           text not null,
  field_type      custom_field_type not null default 'text',
  options         jsonb not null default '[]'::jsonb,
  "order"         integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (organization_id, entity_type, key)
);

-- =============================================================================
-- Triggers and integrity
-- =============================================================================

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger contacts_updated_at  before update on contacts  for each row execute function set_updated_at();
create trigger companies_updated_at before update on companies for each row execute function set_updated_at();
create trigger deals_updated_at     before update on deals     for each row execute function set_updated_at();

-- Stage inherits its organization from its pipeline, and can never be moved to
-- a pipeline in another organization.
create or replace function stages_sync_organization()
returns trigger
language plpgsql
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from pipelines where id = new.pipeline_id;
  if v_org is null then
    raise exception 'pipeline % does not exist', new.pipeline_id;
  end if;
  new.organization_id = v_org;
  return new;
end;
$$;

create trigger stages_sync_organization
  before insert or update of pipeline_id on stages
  for each row execute function stages_sync_organization();

-- A deal's stage must belong to the deal's own organization. Without this a
-- correctly-scoped write could still point at another tenant's stage.
create or replace function deals_validate_stage()
returns trigger
language plpgsql
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from stages where id = new.stage_id;
  if v_org is distinct from new.organization_id then
    raise exception 'stage % does not belong to organization %', new.stage_id, new.organization_id;
  end if;
  return new;
end;
$$;

create trigger deals_validate_stage
  before insert or update of stage_id, organization_id on deals
  for each row execute function deals_validate_stage();

-- Acceptance criterion 6.3: moving a deal between stages updates its
-- probability to the new stage's default unless the user has overridden it.
create or replace function deals_apply_stage_probability()
returns trigger
language plpgsql
as $$
declare
  v_default numeric(4, 3);
begin
  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    if not new.probability_overridden then
      select default_probability into v_default from stages where id = new.stage_id;
      if v_default is not null then
        new.probability = v_default;
      end if;
    end if;
  end if;

  -- Closing a deal stamps the close date; reopening clears it.
  if new.status in ('won', 'lost') and new.actual_close_date is null then
    new.actual_close_date = current_date;
  elsif new.status = 'open' then
    new.actual_close_date = null;
  end if;

  return new;
end;
$$;

create trigger deals_apply_stage_probability
  before insert or update on deals
  for each row execute function deals_apply_stage_probability();

-- contact_tags carries organization_id for a uniform RLS predicate; derive it
-- from the contact and refuse cross-tenant pairings.
create or replace function contact_tags_sync_organization()
returns trigger
language plpgsql
as $$
declare
  v_contact_org uuid;
  v_tag_org     uuid;
begin
  select organization_id into v_contact_org from contacts where id = new.contact_id;
  select organization_id into v_tag_org from tags where id = new.tag_id;
  if v_contact_org is null or v_tag_org is null or v_contact_org <> v_tag_org then
    raise exception 'contact and tag must belong to the same organization';
  end if;
  new.organization_id = v_contact_org;
  return new;
end;
$$;

create trigger contact_tags_sync_organization
  before insert or update on contact_tags
  for each row execute function contact_tags_sync_organization();

-- Every new organization starts with a usable default pipeline, so a deal can
-- be created the moment the first user logs in.
create or replace function organizations_seed_pipeline()
returns trigger
language plpgsql
as $$
declare
  v_pipeline uuid;
begin
  insert into pipelines (organization_id, name, is_default)
  values (new.id, 'Sales Pipeline', true)
  returning id into v_pipeline;

  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values
    (new.id, v_pipeline, 'New',           0, 0.100),
    (new.id, v_pipeline, 'Qualified',     1, 0.250),
    (new.id, v_pipeline, 'Proposal Sent', 2, 0.500),
    (new.id, v_pipeline, 'Negotiation',   3, 0.750),
    (new.id, v_pipeline, 'Won',           4, 1.000),
    (new.id, v_pipeline, 'Lost',          5, 0.000);

  return new;
end;
$$;

create trigger organizations_seed_pipeline
  after insert on organizations
  for each row execute function organizations_seed_pipeline();
