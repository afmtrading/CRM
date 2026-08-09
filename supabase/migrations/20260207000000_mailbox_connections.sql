-- =============================================================================
-- Connected mailboxes
--
-- One row per mailbox a person has linked to the CRM. The connector reads these
-- to know whose mail to poll and where it got to last time.
--
-- The refresh token is the sharp edge here: it is a permanent key to somebody's
-- entire mailbox. Three things keep it away from the application:
--
--   1. It is stored encrypted (AES-256-GCM, key in MAILBOX_TOKEN_KEY). The
--      database never sees the plaintext, so a database backup is not a set of
--      mailbox keys.
--   2. `authenticated` holds a column-level grant that deliberately excludes
--      it. `select *` on this table is *refused* for a signed-in user — by
--      design. Read the named columns instead.
--   3. Nothing but the service role writes to the table at all. Connecting
--      happens in the OAuth callback, disconnecting through the definer
--      function below.
-- =============================================================================

do $$
begin
  if to_regprocedure('public.current_app_user_id()') is null then
    raise exception 'Run the earlier migrations first — this one builds on current_app_user_id().';
  end if;
end
$$;

create table if not exists mailbox_connections (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  -- The CRM user whose mailbox this is. Their activities are attributed to
  -- them, so losing the user should lose the connection with them.
  user_id         uuid not null references users (id) on delete cascade,
  provider        text not null default 'gmail' check (provider in ('gmail')),
  email_address   text not null,
  /** Encrypted envelope, never plaintext. See src/lib/crypto.ts. */
  refresh_token   text,
  /** Gmail's incremental cursor. Null means "next run does a backfill". */
  history_id      text,
  /** How far back the first sync reaches. Everything ever is mostly noise. */
  backfill_days   integer not null default 30 check (backfill_days between 1 and 365),
  status          text not null default 'active'
    check (status in ('active', 'needs_reauth', 'disabled')),
  /** Last failure, shown in settings so a broken connection is visible. */
  last_error      text,
  last_synced_at  timestamptz,
  messages_logged integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table mailbox_connections is
  'Linked mailboxes. refresh_token is encrypted and is not granted to authenticated — select named columns, never *.';

create index if not exists mailbox_connections_org_idx
  on mailbox_connections (organization_id);
create index if not exists mailbox_connections_user_idx
  on mailbox_connections (organization_id, user_id);
-- The poller's own query: everything still worth polling, oldest first.
create index if not exists mailbox_connections_due_idx
  on mailbox_connections (last_synced_at nulls first) where status = 'active';

-- Plain columns rather than lower(email_address): the OAuth callback upserts on
-- exactly these three, and PostgREST's on_conflict cannot target an expression
-- index. The address is lowercased before it is written, so this is the same
-- constraint by another route.
create unique index if not exists mailbox_connections_address_idx
  on mailbox_connections (organization_id, provider, email_address);

create trigger mailbox_connections_updated_at
  before update on mailbox_connections
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- Grants
--
-- The column list is the security boundary, not a convenience: refresh_token is
-- absent from it, so no signed-in user can read a token even through a crafted
-- PostgREST request. Writes are not granted at all.
-- -----------------------------------------------------------------------------
revoke all on mailbox_connections from anon;
revoke all on mailbox_connections from authenticated;

grant select (
  id,
  organization_id,
  user_id,
  provider,
  email_address,
  history_id,
  backfill_days,
  status,
  last_error,
  last_synced_at,
  messages_logged,
  created_at,
  updated_at
) on mailbox_connections to authenticated;

alter table mailbox_connections enable row level security;
alter table mailbox_connections force row level security;

-- Your own mailboxes, and — for an administrator — everyone's, so a broken
-- connection can be spotted without asking each person in turn.
drop policy if exists mailbox_connections_select on mailbox_connections;
create policy mailbox_connections_select on mailbox_connections
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and (user_id = public.current_app_user_id() or public.is_org_admin())
  );

-- -----------------------------------------------------------------------------
-- Disconnecting
--
-- Definer, for the usual reason: authenticated has no write grant at all, and
-- the token has to be destroyed rather than merely hidden. A revoked connection
-- keeps its row so the settings page can say the mailbox was disconnected
-- instead of quietly forgetting it existed.
-- -----------------------------------------------------------------------------
create or replace function public.disconnect_mailbox(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   uuid := public.current_org_id();
  v_owner uuid;
begin
  select user_id into v_owner
  from public.mailbox_connections
  where id = p_connection_id and organization_id = v_org;

  if v_owner is null then
    raise exception 'Mailbox connection not found';
  end if;

  if v_owner <> public.current_app_user_id() and not public.is_org_admin() then
    raise exception 'You can only disconnect your own mailbox';
  end if;

  update public.mailbox_connections
  set status = 'disabled',
      refresh_token = null,
      history_id = null,
      last_error = null
  where id = p_connection_id and organization_id = v_org;
end;
$$;

/** How far back the next backfill reaches. An administrator's setting. */
create or replace function public.set_mailbox_backfill(p_connection_id uuid, p_days integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can change the backfill window';
  end if;

  if p_days is null or p_days < 1 or p_days > 365 then
    raise exception 'The backfill window must be between 1 and 365 days';
  end if;

  update public.mailbox_connections
  set backfill_days = p_days
  where id = p_connection_id and organization_id = public.current_org_id();
end;
$$;

revoke execute on function public.disconnect_mailbox(uuid) from public;
revoke execute on function public.set_mailbox_backfill(uuid, integer) from public;
grant execute on function public.disconnect_mailbox(uuid) to authenticated, service_role;
grant execute on function public.set_mailbox_backfill(uuid, integer) to authenticated, service_role;
