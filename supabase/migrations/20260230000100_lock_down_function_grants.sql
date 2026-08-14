-- =============================================================================
-- Close the RPC surface, and pin every function's search_path
--
-- THE HOLE
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, and PostgREST
-- publishes everything in this schema at /rest/v1/rpc/<name>. Between them, 77
-- functions were callable by `anon` — that is, by anybody with the publishable
-- key and no session at all.
--
-- Most would fail once they got going, because current_org_id() returns null
-- for a caller with no JWT. Some would not:
--
--   notify_admins(p_org, ...)  takes the organization as an argument and
--                              inserts a notification. It never consults the
--                              caller, so anon could write into any org.
--   create_birthday_reminders  writes activities across every organization.
--   link_auth_user             a trigger function, exposed as an RPC.
--
-- Ten trigger functions were reachable this way. A trigger function has no
-- business being an HTTP endpoint under any circumstances.
--
-- The intent was already written down — src/app/unsubscribe/unsubscribe-form.tsx
-- says unsubscribe_by_token is "one of exactly two functions anon may execute".
-- That was true of the design and false of the database. This makes it true of
-- the database.
--
-- WHAT CHANGES FOR SIGNED-IN USERS
--
-- Nothing. EXECUTE is revoked from PUBLIC and re-granted to `authenticated` and
-- `service_role` in the same statement, so every path that worked still works —
-- the grant simply stops being inherited by anon along the way. Tightening what
-- an authenticated user may call is a separate exercise: the RLS helpers are
-- called from inside policies and inlined SQL bodies, so the set that actually
-- needs the grant is subtler than the set the application calls by name, and
-- getting it wrong locks people out of their own records.
--
-- SEARCH PATH
--
-- 34 functions had no `set search_path`, so they resolved unqualified names
-- through the caller's path. pg_temp is searched before public for tables, so a
-- user who can create a temporary table can shadow one an unqualified query
-- reads — which matters most for the SECURITY DEFINER functions here, since
-- those run as the owner. Pinning the path costs nothing and removes the class.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

do $$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as sig,
           pg_get_function_result(p.oid) = 'trigger' as is_trigger,
           /*
            * Null means nobody ever said anything about this function's grants,
            * so it still carries Postgres's default of owner plus PUBLIC. A
            * populated ACL means an earlier migration made a deliberate choice,
            * and that choice is not this migration's to widen — claim_campaign_batch
            * is service_role and no more, on purpose, and the campaign tests
            * assert it.
            */
           p.proacl is null as grants_are_default
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon', v_fn.sig);

    if v_fn.is_trigger then
      /*
       * A trigger fires as part of the statement that set it off: EXECUTE is
       * checked when the trigger is created, never when it runs. So a trigger
       * function needs no grant from anybody, and taking the grants away is
       * what removes it from the REST surface.
       *
       * Unconditional, unlike the branch below, because this is not a policy
       * decision anybody could have made deliberately — production had explicit
       * `authenticated` grants on all 26 of these, inherited from Supabase's
       * default privileges on the public schema rather than from any migration
       * here. Leaving them would have made a database that passed locally and
       * failed in production, which is the worst kind of difference to have.
       */
      execute format('revoke execute on function %s from authenticated', v_fn.sig);
    elsif v_fn.grants_are_default then
      execute format('grant execute on function %s to authenticated, service_role', v_fn.sig);
    end if;
  end loop;
end
$$;

-- The two exceptions, and the reason the rule exists.
--
-- An unsubscribe link is opened by somebody who is not signed in and never will
-- be — that is the whole point of it. Both take nothing but the token, which is
-- unguessable and identifies exactly one contact, so possession of the link is
-- the authorization.
grant execute on function public.unsubscribe_by_token(uuid) to anon;
grant execute on function public.unsubscribe_check(uuid) to anon;

-- -----------------------------------------------------------------------------
-- search_path
--
-- Applied to every function that lacks one rather than to a list, so a function
-- added later without one is the only way to reintroduce the problem.
-- -----------------------------------------------------------------------------

do $$
declare
  v_sig text;
begin
  for v_sig in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}')) as c
        where c like 'search_path=%'
      )
  loop
    execute format('alter function %s set search_path = public, pg_temp', v_sig);
  end loop;
end
$$;
