-- =============================================================================
-- Anon may execute four functions and read one table, and this makes it true
--
-- 20260230000100_lock_down_function_grants said it plainly: "The comment at the
-- top of unsubscribe-form.tsx says unsubscribe_by_token is one of exactly two
-- functions anon may execute. That was true of the design and false of the
-- database." It made it true. Then twelve more functions were added over the
-- following months, and it stopped being true again.
--
-- WHY IT COMES BACK
--
-- Supabase's default privileges on the public schema grant EXECUTE to anon
-- *directly* on every function as it is created. So this is not a mistake
-- anybody made; it is the floor the schema sits on, and it re-applies itself
-- to every `create function` written from now on. Two consequences worth
-- knowing:
--
--   * a migration that revokes from PUBLIC has not revoked from anon. The
--     campaigns migration spotted this in 2026-02 and said so; the twelve
--     functions below are what happens when only some migrations remember.
--   * `proacl is null` does not identify the problem. Every one of the twelve
--     has a populated ACL — it just has `anon=X` in it. The earlier sweep keyed
--     on a null ACL, which is why re-running it would have found nothing.
--
-- So this keys on the only thing that actually matters: can anon execute it.
--
-- WHAT WAS REACHABLE
--
-- The anon key ships in the browser bundle, so anything anon may execute is
-- reachable by anybody with the URL, at /rest/v1/rpc/<name>. Of the twelve,
-- three had teeth — add_invoice_line, rename_option_value and
-- rename_custom_field_value are SECURITY DEFINER and write. None of them was
-- actually exploitable: each reads public.current_org_id() first, which is null
-- for a caller with no session, so the renames refuse and the insert matches no
-- organization. Four are pure helpers, and five are trigger functions that
-- PostgREST would not expose anyway.
--
-- That is a defence in depth report, not an all-clear. The guard inside a
-- function is the second lock; this is the first one, and it should not be
-- left open on the argument that the second one held.
--
-- WHAT STAYS OPEN, AND WHY
--
--   unsubscribe_by_token, unsubscribe_check   the person clicking an
--     unsubscribe link has no account and must not need one.
--   marketing_form_public, submit_marketing_form   the person filling in a
--     lead-capture form is, by definition, not in the CRM yet.
--
-- Four, named below, and the assertion at the bottom fails the migration if
-- that stops being the whole list.
--
-- AND THE SAME THING HAPPENED TO THE TABLES
--
-- Found while checking the above, and it is the identical defect one level up:
-- the default privileges grant anon *all four* of select, insert, update and
-- delete on every table as it is created, and seventeen tables still carried
-- them — invoices, sales_orders, campaigns, email_lists, sending_domains and
-- the rest.
--
-- Nothing was readable. Every one of those tables has RLS enabled and FORCEd
-- with policies written `to authenticated`, and a policy that names
-- authenticated does not apply to anon — so with no policy reaching it, anon is
-- refused everything. contact_mailability is a view rather than a table and has
-- no policies of its own, but it is security_invoker, so it resolves against
-- contacts under the caller's own privileges and anon has none: reading it
-- fails with "permission denied for table contacts" rather than returning rows.
-- That was checked against production, not assumed.
--
-- This is therefore a tidy-up and not an incident. It is worth doing anyway,
-- because the grant is the first lock and RLS is the second, and "the second
-- one held" is not a reason to leave the first one open. It also makes the
-- sentence in the README true rather than aspirational.
--
-- public.countries keeps `select`, which is deliberate: it is the ISO country
-- list, it carries no organization_id, and 20260238000000 granted it to anon on
-- purpose with a `for select using (true)` policy to match. What it loses is
-- insert, update and delete, which nobody meant to grant and which the policy
-- was refusing anyway.
-- =============================================================================

do $$
declare
  /*
   * The public surface, by name.
   *
   * By name rather than by full signature because these four have no overloads
   * and are not going to grow any — and a signature list would silently stop
   * protecting a function the day somebody added an argument to it, which is
   * the failure this file exists to stop repeating.
   */
  c_allowed constant text[] := array[
    'unsubscribe_by_token', 'unsubscribe_check',
    'marketing_form_public', 'submit_marketing_form'
  ];

  v_fn      record;
  v_revoked int := 0;
  v_open    text[];
begin
  for v_fn in
    select p.oid::regprocedure as sig,
           pg_get_function_result(p.oid) = 'trigger' as is_trigger
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and has_function_privilege('anon', p.oid, 'execute')
      and not (p.proname = any (c_allowed))
  loop
    /*
     * PUBLIC as well as anon. The two are separate grants and both were present
     * on most of these — revoking one and not the other is exactly how the
     * previous attempt left anon standing.
     */
    execute format('revoke execute on function %s from public, anon', v_fn.sig);

    if v_fn.is_trigger then
      /*
       * A trigger function needs no grant from anybody: EXECUTE is checked when
       * the trigger is created, never when it fires. So these lose authenticated
       * as well, which is what takes them off the REST surface entirely — the
       * same treatment stamp_deal_actor got in 20260259000000.
       */
      execute format('revoke execute on function %s from authenticated', v_fn.sig);
    else
      /*
       * And everything else gets authenticated put back explicitly.
       *
       * This is not redundant, and leaving it out broke two test files before
       * it went in. On a hosted project these functions carry an explicit
       * `authenticated=X` from Supabase's default privileges, so revoking
       * PUBLIC costs them nothing. On a database built from these migrations
       * alone — `npm run test:db`, and any local Postgres — there are no
       * default privileges, the ACL is null, and *every* role reaches the
       * function through PUBLIC. Revoking PUBLIC there locks out the
       * application as well as anon.
       *
       * Re-granting cannot widen anything: a function only enters this loop if
       * anon could already execute it, which in either world means authenticated
       * could too. The deliberately narrow ones — claim_campaign_batch is
       * service_role and no more — are not reachable by anon and so are never
       * seen here.
       */
      execute format('grant execute on function %s to authenticated, service_role', v_fn.sig);
    end if;

    v_revoked := v_revoked + 1;
    raise notice 'revoked anon execute on %', v_fn.sig;
  end loop;

  raise notice 'anon can no longer execute % function(s)', v_revoked;

  /*
   * And prove it, here rather than only in a test, so applying this to a
   * database where something unexpected is exposed fails the deploy instead of
   * reporting success and leaving it open.
   */
  select coalesce(array_agg(p.oid::regprocedure::text order by p.proname), '{}')
  into v_open
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'execute')
    and not (p.proname = any (c_allowed));

  if array_length(v_open, 1) > 0 then
    raise exception 'anon can still execute: %', array_to_string(v_open, ', ');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- The same sweep, for tables
--
-- `authenticated` is deliberately untouched throughout. Every one of these
-- tables is reached by the application as a signed-in user, and the tenancy
-- rules that decide what it may see live in the policies, not here.
-- -----------------------------------------------------------------------------
do $$
declare
  /* Table, privilege — what anon legitimately keeps. See the header. */
  c_allowed_table constant text := 'countries';
  c_allowed_priv  constant text := 'SELECT';

  v_rel     record;
  v_revoked int := 0;
  v_open    text[];
begin
  for v_rel in
    select c.oid::regclass as rel, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'v', 'p', 'm', 'f')
      and (has_table_privilege('anon', c.oid, 'SELECT')
        or has_table_privilege('anon', c.oid, 'INSERT')
        or has_table_privilege('anon', c.oid, 'UPDATE')
        or has_table_privilege('anon', c.oid, 'DELETE'))
  loop
    execute format('revoke all on %s from anon', v_rel.rel);

    -- Put back the one grant that was meant.
    if v_rel.relname = c_allowed_table then
      execute format('grant %s on %s to anon', c_allowed_priv, v_rel.rel);
    end if;

    v_revoked := v_revoked + 1;
    raise notice 'tightened anon on %', v_rel.rel;
  end loop;

  raise notice 'anon privileges tightened on % relation(s)', v_revoked;

  select coalesce(array_agg(c.relname order by c.relname), '{}')
  into v_open
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'v', 'p', 'm', 'f')
    and c.relname <> c_allowed_table
    and (has_table_privilege('anon', c.oid, 'SELECT')
      or has_table_privilege('anon', c.oid, 'INSERT')
      or has_table_privilege('anon', c.oid, 'UPDATE')
      or has_table_privilege('anon', c.oid, 'DELETE'));

  if array_length(v_open, 1) > 0 then
    raise exception 'anon still holds privileges on: %', array_to_string(v_open, ', ');
  end if;

  if has_table_privilege('anon', 'public.countries', 'INSERT') then
    raise exception 'countries should be readable by anon, not writable';
  end if;
end
$$;
