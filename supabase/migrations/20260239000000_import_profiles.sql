-- =============================================================================
-- Remembering how a list was read last time
--
-- WHAT THIS REPLACES
--
-- The plan was for a model to work out the column mapping and the value
-- normalisation on every import. It does not need to, and on this axis it would
-- be worse: a model re-derives its answer each time and can quietly reach a
-- different one, so the same file imported twice can land differently. A saved
-- rule is the same next month, and it gets more accurate as it is used rather
-- than staying wherever it started.
--
-- So the decisions somebody makes on the review screen are kept: which column
-- goes where, which spellings are the same thing, which values in the name
-- column are placeholders rather than people. The next file with those headings
-- needs almost nothing.
--
-- HOW A FILE IS RECOGNISED
--
-- By its headings, not its name. A list arrives as
-- "acheteurs_potentiels_combine__AI_master_contacts_cleaned__1.csv" this month
-- and something else next month, but the columns stay put. The signature is the
-- headings, lower-cased, trimmed and sorted, joined — so column order can move
-- without losing the match, and a genuinely different file gets a different
-- profile rather than the wrong one.
--
-- WHY THE MERGES ARE NOT A WHITELIST
--
-- value_merges is a set of corrections: "PLATFORM means Marketplace". A value
-- with no rule passes through unchanged. Reading it as a list of permitted
-- values instead would make every new category vanish the moment a profile
-- existed, which is the opposite of the point — a saved profile should make the
-- familiar cheap without making the unfamiliar invisible.
-- =============================================================================

create table if not exists public.import_profiles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null,

  /** The headings, lower-cased, sorted and joined. See above. */
  signature       text not null,
  /** The headings as they were, for showing somebody what this profile is. */
  headers         text[] not null default '{}',

  /** Column heading to target key: {"Company / Channel": "company.name"}. */
  mapping         jsonb not null default '{}',
  /** Per option field, spelling to spelling: {"customer_type": {"PLATFORM": "Marketplace"}}. */
  value_merges    jsonb not null default '{}',
  /** Values in the contact-name column that are not people. */
  placeholders    text[] not null default '{}',

  /** So the list can be ordered by what is actually used. */
  times_used      integer not null default 0,
  last_used_at    timestamptz,

  created_by      uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One profile per file shape per organization: a second one for the same
-- headings would make "which did it use" unanswerable.
create unique index if not exists import_profiles_signature
  on public.import_profiles (organization_id, signature);

create index if not exists import_profiles_org_idx
  on public.import_profiles (organization_id, last_used_at desc nulls last);

drop trigger if exists import_profiles_updated_at on public.import_profiles;
create trigger import_profiles_updated_at
  before update on public.import_profiles
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Who may read and write one
--
-- The same capability that governs importing at all. A profile is a description
-- of how to read a file, not customer data — but it is still one organization's
-- own, and it is written by the act of importing, so it lives behind exactly
-- the same door.
-- -----------------------------------------------------------------------------
alter table public.import_profiles enable row level security;
alter table public.import_profiles force row level security;

drop policy if exists import_profiles_select on public.import_profiles;
create policy import_profiles_select on public.import_profiles
  for select to authenticated
  using (organization_id = (select public.current_org_id()));

drop policy if exists import_profiles_insert on public.import_profiles;
create policy import_profiles_insert on public.import_profiles
  for insert to authenticated
  with check (
    organization_id = (select public.current_org_id()) and (select public.can_bulk_records())
  );

drop policy if exists import_profiles_update on public.import_profiles;
create policy import_profiles_update on public.import_profiles
  for update to authenticated
  using (
    organization_id = (select public.current_org_id()) and (select public.can_bulk_records())
  )
  with check (
    organization_id = (select public.current_org_id()) and (select public.can_bulk_records())
  );

drop policy if exists import_profiles_delete on public.import_profiles;
create policy import_profiles_delete on public.import_profiles
  for delete to authenticated
  using (
    organization_id = (select public.current_org_id()) and (select public.can_bulk_records())
  );

revoke all on public.import_profiles from public, anon;
grant select, insert, update, delete on public.import_profiles to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Saving one
--
-- Upsert by signature rather than by id, because the caller has a file rather
-- than a profile: "here is what I decided about these headings" is the whole
-- interaction, and whether that is the first or the fortieth time is not
-- something the screen should have to work out.
--
-- SECURITY DEFINER for the counter alone. times_used has to increment whether
-- the row was just made or was already there, and doing that from the app would
-- mean a read, a decision and a write that another import could interleave with.
-- -----------------------------------------------------------------------------
create or replace function public.save_import_profile(
  p_name         text,
  p_signature    text,
  p_headers      text[],
  p_mapping      jsonb,
  p_value_merges jsonb,
  p_placeholders text[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org  uuid := public.current_org_id();
  v_name text := btrim(coalesce(p_name, ''));
  v_id   uuid;
begin
  if not public.can_bulk_records() then
    raise exception 'You do not have permission to import';
  end if;

  if btrim(coalesce(p_signature, '')) = '' then
    raise exception 'A profile needs the columns it was built from';
  end if;

  if v_name = '' then
    v_name := 'Untitled list';
  end if;

  insert into public.import_profiles (
    organization_id, name, signature, headers, mapping, value_merges, placeholders,
    times_used, last_used_at, created_by
  )
  values (
    v_org, v_name, p_signature, coalesce(p_headers, '{}'),
    coalesce(p_mapping, '{}'::jsonb), coalesce(p_value_merges, '{}'::jsonb),
    coalesce(p_placeholders, '{}'),
    1, now(), public.current_app_user_id()
  )
  on conflict (organization_id, signature) do update set
    -- The name is not overwritten: somebody called it "Acme buyer list" on
    -- purpose, and the file it came from is called something else every month.
    mapping      = excluded.mapping,
    value_merges = excluded.value_merges,
    placeholders = excluded.placeholders,
    headers      = excluded.headers,
    times_used   = public.import_profiles.times_used + 1,
    last_used_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.save_import_profile(text, text, text[], jsonb, jsonb, text[])
  from public, anon;
grant execute on function public.save_import_profile(text, text, text[], jsonb, jsonb, text[])
  to authenticated, service_role;
