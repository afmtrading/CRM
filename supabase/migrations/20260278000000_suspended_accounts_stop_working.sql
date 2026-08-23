-- =============================================================================
-- A suspended account stops working in the background too
--
-- 20260277000000 made organizations.status mean something for anybody holding a
-- session: current_org_id() resolves to null, every policy refuses, and the
-- interface says why. It deliberately left the background alone, and said so —
-- service_role bypasses RLS, so the cron drains and the mailbox poller carried
-- on for an account nobody could sign in to.
--
-- That was the wrong place to stop. An account switched off on Friday would
-- have spent the weekend sending its campaigns to its customers, pulling its
-- staff's email into a CRM they could not open, and filing birthday tasks for
-- nobody. "Suspended" has to mean the account is not doing anything, or it does
-- not mean much.
--
-- WHAT STOPS
--
--   scheduled campaigns   are not started
--   sending campaigns     are paused, keeping their outbox intact
--   birthday reminders    are not created
--   the mailbox poller    skips the account's connections (in the route)
--   the ingest endpoint   refuses the account by name (in the route)
--
-- WHAT DOES NOT, AND THIS IS THE IMPORTANT ONE
--
-- record_email_event keeps working, on purpose. Those are the provider's
-- reports about mail that has *already left* — delivered, opened, bounced,
-- marked as spam. Refusing them would not un-send anything; it would only mean
-- not knowing what happened to it.
--
-- The part that matters is the suppression. A hard bounce or a complaint writes
-- a row that stops that address ever being mailed again, and dropping those
-- while an account is suspended would mean a complaint is never recorded, the
-- suppression never written, and the address mailed again the moment the
-- account comes back. Suspension must not be a way to lose the record of
-- somebody asking to be left alone.
--
-- PAUSED RATHER THAN CANCELLED
--
-- A campaign mid-flight is moved to 'paused', which already means exactly this:
-- "stopped by hand; pending rows stay pending". Nobody is half-mailed, nothing
-- is lost, and reactivating the account does not silently resume a send that a
-- person should decide to resume. It shows as paused on the campaign screen,
-- which is true — it was paused, by the account being switched off.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- One definition, since four callers need the same answer
--
-- The alternative is the same join written out in four places, which is how the
-- next background job to be added forgets it.
-- -----------------------------------------------------------------------------
create or replace function public.organization_is_active(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org and o.status = 'active'
  );
$$;

comment on function public.organization_is_active(uuid) is
  'Whether an organization is switched on. Consulted by the background jobs, which run as service_role and so are not covered by current_org_id().';

revoke execute on function public.organization_is_active(uuid) from public, anon;
grant execute on function public.organization_is_active(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Campaigns
-- -----------------------------------------------------------------------------

/**
 * Pauses whatever a suspended account had in flight.
 *
 * Called by the drain before it claims anything, so the pause happens on the
 * same tick the suspension is noticed rather than a batch later. There is still
 * a window of one run — a campaign suspended halfway through a claimed batch
 * finishes that batch — and that is the right side to err on: those messages
 * have already been handed to the provider, and pretending otherwise would mean
 * marking sent mail as unsent.
 */
create or replace function public.pause_suspended_campaigns()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update campaigns c
  set status = 'paused'
  where c.status in ('scheduled', 'sending')
    and not public.organization_is_active(c.organization_id);

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function public.pause_suspended_campaigns() from public, anon, authenticated;
grant execute on function public.pause_suspended_campaigns() to service_role;

/**
 * Moves scheduled campaigns whose time has come into sending.
 *
 * Now skips suspended accounts, so a campaign scheduled before the suspension
 * does not start after it. Without this the pause above would fight the start
 * every minute, pausing what the same run had just started.
 */
create or replace function public.start_due_campaigns()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update campaigns
  set status = 'sending', started_at = coalesce(started_at, now())
  where status = 'scheduled'
    and (scheduled_at is null or scheduled_at <= now())
    and public.organization_is_active(organization_id);

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- -----------------------------------------------------------------------------
-- Birthday reminders
--
-- Taken with pg_get_functiondef rather than retyped, for the reason
-- 20260237000000 gives at length: rebuilding one of these from its body alone
-- silently dropped SECURITY DEFINER once already, and the tenant-isolation
-- tests are what caught it. The whole definition is read, one predicate is
-- added to the scan, and the result is put back.
-- -----------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_old text := 'and c.hidden is false';
  v_new text := 'and c.hidden is false
      -- A suspended account files no tasks; see 20260278000000.
      and public.organization_is_active(c.organization_id)';
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_birthday_reminders';

  if v_def is null then
    raise exception 'create_birthday_reminders is missing — run the earlier migrations first';
  end if;

  -- Idempotent: applying this twice is a no-op rather than two predicates.
  if position('organization_is_active' in v_def) > 0 then
    return;
  end if;

  if position(v_old in v_def) = 0 then
    raise exception 'create_birthday_reminders no longer contains the hidden-records predicate this migration keys on — reconcile by hand';
  end if;

  execute replace(v_def, v_old, v_new);
end
$$;

-- The grants are not restated by CREATE OR REPLACE, but the revoke from
-- 20260237000000 is, so this re-asserts the narrow one it ended on.
revoke execute on function public.create_birthday_reminders(integer) from public, anon, authenticated;
grant execute on function public.create_birthday_reminders(integer) to service_role;

-- -----------------------------------------------------------------------------
-- Prove it took
-- -----------------------------------------------------------------------------
do $$
begin
  if position('organization_is_active' in
      (select pg_get_functiondef(p.oid) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='create_birthday_reminders')) = 0 then
    raise exception 'create_birthday_reminders was not gated';
  end if;

  if not (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname='create_birthday_reminders') then
    raise exception 'create_birthday_reminders lost SECURITY DEFINER — this is the 20260237000000 mistake happening again';
  end if;
end
$$;
