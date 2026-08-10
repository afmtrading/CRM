-- =============================================================================
-- Local test harness: the parts of a Supabase project that the migrations
-- depend on but do not create themselves.
--
-- Supabase provisions these in a hosted project. Recreating them here is what
-- lets `npm run test:db` run the real migrations and the real RLS policies
-- against a throwaway Postgres, rather than trusting them by inspection.
-- =============================================================================

-- Roles PostgREST authenticates as.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant anon, authenticated, service_role to postgres;

create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);

-- Supabase's auth.uid(): the signed-in user, read from the request's JWT
-- claims. In tests the claims are set with set_config(), which is exactly how
-- PostgREST supplies them in production.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  -- Mirrors Supabase's own definition, including the nullif guard that keeps
  -- an absent or blank claims setting from blowing up the ::jsonb cast.
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
