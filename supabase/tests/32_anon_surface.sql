-- =============================================================================
-- What a caller with no session can do.
--
--   The anon key ships inside the browser bundle. It is not a secret and was
--   never meant to be one, so "anon can execute this" means "anybody with the
--   URL can execute this, at /rest/v1/rpc/<name>".
--
--   That surface has now been closed twice — once in 20260230000100, once in
--   20260276000000 — and re-opened in between by nothing worse than people
--   writing `create function`, because Supabase's default privileges grant
--   EXECUTE to anon as each one is created. A comment cannot stop that. This
--   file can: it fails the moment a thirteenth function joins the list.
--
--   The four that stay open are the two ways somebody who is not in the CRM
--   legitimately reaches it — an unsubscribe link, and a lead-capture form.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

create or replace function test_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not p_condition then
    raise exception 'TEST FAILED: %', p_message;
  end if;
  raise notice '  ok: %', p_message;
end;
$$;

/*
 * The harness obeys the rule it is testing. test_assert is created in `public`
 * like every other helper in this directory, and Supabase's default privileges
 * hand anon EXECUTE on it the moment it exists — which is the whole mechanism
 * under test, and it caught this file on the first run.
 */
revoke execute on function test_assert(boolean, text) from public, anon;

do $$
declare
  c_expected constant text[] := array[
    'marketing_form_public', 'submit_marketing_form',
    'unsubscribe_by_token', 'unsubscribe_check'
  ];
  v_actual text[];
begin
  raise notice 'The anonymous surface:';

  select coalesce(array_agg(distinct p.proname order by p.proname), '{}')
  into v_actual
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'execute');

  /*
   * Equality, not containment. A test that only checked the four were present
   * would pass with a fifth beside them, which is the exact failure this is
   * for. If this fails, the answer is almost never to edit the list — it is
   * that a new function picked up Supabase's default grant, and the migration
   * that added it needs `revoke execute ... from public, anon`.
   */
  perform test_assert(
    v_actual = (select array_agg(x order by x) from unnest(c_expected) x),
    format('anon may execute exactly these four functions, and got: %s',
           array_to_string(v_actual, ', '))
  );
end;
$$;

-- =============================================================================
-- No tables, either.
-- =============================================================================
do $$
declare
  v_open text[];
begin
  raise notice 'Tables:';

  select coalesce(array_agg(c.relname order by c.relname), '{}')
  into v_open
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'v', 'p')
    and (has_table_privilege('anon', c.oid, 'SELECT')
      or has_table_privilege('anon', c.oid, 'INSERT')
      or has_table_privilege('anon', c.oid, 'UPDATE')
      or has_table_privilege('anon', c.oid, 'DELETE'));

  /*
   * countries is the one exception and is deliberate: the ISO country list,
   * no organization_id, granted to anon in 20260238000000 with a matching
   * `for select using (true)` policy. Read-only — it must not be writable.
   */
  perform test_assert(
    v_open = array['countries'],
    format('anon reads the country list and nothing else, and got: %s',
           array_to_string(v_open, ', '))
  );

  perform test_assert(
    not has_table_privilege('anon', 'public.countries', 'INSERT')
    and not has_table_privilege('anon', 'public.countries', 'UPDATE')
    and not has_table_privilege('anon', 'public.countries', 'DELETE'),
    'and cannot write to it'
  );
end;
$$;

-- =============================================================================
-- The four that stay open still work.
--
-- Revoking too much is the other way to get this wrong, and it would break an
-- unsubscribe link — which is the one thing in here that is a legal obligation
-- rather than a feature.
-- =============================================================================

/*
 * The harness helper is handed back only now, after both assertions above have
 * already read the live grants. The block below runs as anon and has to be able
 * to report what it finds.
 */
grant execute on function test_assert(boolean, text) to anon;

set local role anon;

do $$
begin
  raise notice 'And they still work:';

  perform test_assert(public.unsubscribe_by_token(gen_random_uuid()) = false,
    'anon can still call unsubscribe_by_token');
  perform test_assert((select count(*) from public.unsubscribe_check(gen_random_uuid())) = 0,
    'anon can still call unsubscribe_check');
  perform test_assert(public.marketing_form_public('no-such-form') is null,
    'anon can still read a form');
  perform test_assert(
    public.submit_marketing_form('no-such-form', '{}'::jsonb) ->> 'ok' = 'false',
    'anon can still submit one');
end;
$$;

reset role;

rollback;
