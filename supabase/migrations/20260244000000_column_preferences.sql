-- -----------------------------------------------------------------------------
-- Which columns each person's lists show
--
-- Per user, not per organization. Two people looking at the same contacts want
-- different columns — somebody chasing territories wants Sells in, somebody
-- pricing wants nothing of the sort — and a shared setting would mean the last
-- one to touch it wins for everybody.
--
-- Text rather than a foreign key to anything. A column key is a string the
-- application knows the meaning of: a real column, a custom field by key, or a
-- derived one like a stock count that is not a column at all. Nothing here
-- validates them, and that is deliberate — resolveColumns drops any key the
-- catalogue no longer has, so a stale preference degrades to a missing column
-- rather than to a broken page, and a constraint here would instead make
-- deleting a custom field fail.
-- -----------------------------------------------------------------------------

create table if not exists public.column_preferences (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references public.users (id) on delete cascade,
  /** 'contact', 'company', 'product'. Free text for the same reason as columns. */
  entity_type     text not null,
  /** In display order. The order is the preference as much as the set is. */
  columns         text[] not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One row per person per list. The upsert below depends on this.
create unique index if not exists column_preferences_user_entity_idx
  on public.column_preferences (user_id, entity_type);

create index if not exists column_preferences_org_idx
  on public.column_preferences (organization_id);

comment on table public.column_preferences is
  'Which columns one person sees on one list, in order. Personal — never read for anybody else.';

drop trigger if exists column_preferences_updated_at on public.column_preferences;
create trigger column_preferences_updated_at
  before update on public.column_preferences
  for each row execute function public.set_updated_at();

alter table public.column_preferences enable row level security;
alter table public.column_preferences force row level security;

/*
 * Your own rows and nobody else's — not even an administrator's, and not even
 * to read. There is nothing in here worth an audit trail and nothing worth
 * administering: it is a view preference, and a manager who could read one
 * would learn nothing except what a colleague likes looking at.
 *
 * Written in the (select …) form so each helper is an InitPlan evaluated once
 * per query rather than once per row, like every other policy since
 * 20260230000000.
 */
drop policy if exists column_preferences_own on public.column_preferences;
create policy column_preferences_own on public.column_preferences
  for all to authenticated
  using (
    organization_id = (select public.current_org_id())
    and user_id = (select public.current_app_user_id())
  )
  with check (
    organization_id = (select public.current_org_id())
    and user_id = (select public.current_app_user_id())
  );

grant select, insert, update, delete on public.column_preferences to authenticated;

-- -----------------------------------------------------------------------------
-- Saving one
--
-- A function rather than an upsert from the application, because the row's
-- identity is (user, entity) and the caller does not know its id. Doing it in
-- the app would be select-then-insert-or-update, which is a race whenever
-- somebody has the same list open twice.
--
-- Invoker, not definer: the policy above is exactly the rule, so there is
-- nothing for a definer to add except the chance of writing somebody else's row
-- by getting the user id wrong. current_app_user_id() decides whose row it is,
-- so a caller cannot name another person's.
-- -----------------------------------------------------------------------------
create or replace function public.save_column_preference(
  p_entity  text,
  p_columns text[]
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_org  uuid := public.current_org_id();
  v_user uuid := public.current_app_user_id();
begin
  if v_org is null or v_user is null then
    raise exception 'No signed-in user in context';
  end if;

  if p_entity not in ('contact', 'company', 'product') then
    raise exception 'There is no % list', p_entity;
  end if;

  /*
   * A ceiling on the array. Nothing renders forty columns usefully, and the
   * only way to get one is a malformed post — a bound here means the table
   * cannot be used as somewhere to park arbitrary data.
   */
  if coalesce(array_length(p_columns, 1), 0) > 40 then
    raise exception 'That is too many columns';
  end if;

  insert into public.column_preferences (organization_id, user_id, entity_type, columns)
  values (v_org, v_user, p_entity, coalesce(p_columns, '{}'))
  on conflict (user_id, entity_type)
  do update set columns = excluded.columns;
end;
$$;

comment on function public.save_column_preference(text, text[]) is
  'Stores one person''s column choice for one list. Whose row it is comes from the session, never from the caller.';

revoke execute on function public.save_column_preference(text, text[]) from public, anon;
grant execute on function public.save_column_preference(text, text[]) to authenticated, service_role;

/** Puts a list back to its defaults by forgetting the choice entirely. */
create or replace function public.reset_column_preference(p_entity text)
returns void
language sql
set search_path = public, pg_temp
as $$
  delete from public.column_preferences
  where user_id = public.current_app_user_id()
    and entity_type = p_entity;
$$;

revoke execute on function public.reset_column_preference(text) from public, anon;
grant execute on function public.reset_column_preference(text) to authenticated, service_role;
