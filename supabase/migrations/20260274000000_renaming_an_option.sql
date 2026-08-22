-- =============================================================================
-- Renaming an option, and taking the records with it
--
-- Settings → Fields could add an option, recolour it and delete it, but never
-- correct one. A typo in a list of values was a delete-and-retype, which is not
-- the same operation: the value is stored on the record as text, not as a
-- foreign key, so every contact, company, product and deal already holding the
-- misspelling kept it, and kept it after the corrected option was added beside
-- it. Two spellings of one thing, and no way back to one.
--
-- So a rename carries. These two functions are what the rename runs after it
-- has written the new value onto the option itself: one for the built-in lists,
-- whose values live in a real column, and one for the custom fields, whose
-- values live in the record's `custom_fields` document.
--
-- Neither knows which list it is renaming. The pairing of an option key to the
-- column that holds its values lives in the app, in OPTION_VALUE_COLUMNS, and
-- restating it here is what let the data-integrity check drift once already.
-- The app passes the table and the column; these validate what they were given
-- and refuse anything else.
-- =============================================================================

/**
 * Rewrites one value of a built-in option list across the records that carry it.
 *
 * Returns how many records changed, so the confirmation can say so — "renamed
 * on 12 companies" is the sentence that tells an administrator the rename did
 * what a rename is supposed to do.
 */
create or replace function public.rename_option_value(
  p_table    text,
  p_column   text,
  p_multiple boolean,
  p_old      text,
  p_new      text
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   uuid := public.current_org_id();
  v_count integer;
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can rename an option';
  end if;

  -- The tables OPTION_VALUE_COLUMNS names, and no others. security definer runs
  -- past RLS, so the scoping below is the only tenancy this function has — a
  -- table outside this list would be one whose organization_id means something
  -- else, or nothing.
  if p_table not in ('contacts', 'companies', 'marketplace_profiles', 'products', 'deals') then
    raise exception 'Unknown table %', p_table;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = p_table
      and column_name = p_column
  ) then
    raise exception 'Unknown column %.%', p_table, p_column;
  end if;

  if p_multiple then
    /*
     * array_replace on its own can leave the same value in twice — a record
     * holding both the old spelling and a stale copy of the new one ends up
     * with a pair. The regroup below keeps each value once, in the position it
     * first appeared, so a multi-select does not grow a duplicate chip.
     */
    execute format(
      'update public.%1$I t
          set %2$I = (
                select coalesce(array_agg(s.value order by s.first_at), ''{}''::text[])
                from (
                  select e as value, min(ord) as first_at
                  from unnest(array_replace(t.%2$I, $1, $2)) with ordinality x(e, ord)
                  group by e
                ) s
              )
        where t.organization_id = $3
          and $1 = any(t.%2$I)',
      p_table, p_column
    ) using p_old, p_new, v_org;
  else
    execute format(
      'update public.%1$I t
          set %2$I = $2
        where t.organization_id = $3
          and t.%2$I = $1',
      p_table, p_column
    ) using p_old, p_new, v_org;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

/**
 * The same rename, for a select field this organization defined itself. Its
 * values sit in the record's `custom_fields` document rather than in a column,
 * which is the only difference — a multi-select is a JSON array there, a single
 * choice a JSON string.
 */
create or replace function public.rename_custom_field_value(
  p_table    text,
  p_key      text,
  p_multiple boolean,
  p_old      text,
  p_new      text
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   uuid := public.current_org_id();
  v_count integer;
begin
  if not public.is_org_admin() then
    raise exception 'Only an administrator can rename an option';
  end if;

  if p_table not in ('contacts', 'companies', 'products', 'deals') then
    raise exception 'Unknown table %', p_table;
  end if;

  if p_multiple then
    execute format(
      'update public.%I t
          set custom_fields = jsonb_set(
                t.custom_fields,
                array[$1],
                (
                  select coalesce(jsonb_agg(s.value order by s.first_at), ''[]''::jsonb)
                  from (
                    select case when e = $2 then $3 else e end as value, min(ord) as first_at
                    from jsonb_array_elements_text(t.custom_fields -> $1) with ordinality x(e, ord)
                    group by 1
                  ) s
                )
              )
        where t.organization_id = $4
          and jsonb_typeof(t.custom_fields -> $1) = ''array''
          and jsonb_exists(t.custom_fields -> $1, $2)',
      p_table
    ) using p_key, p_old, p_new, v_org;
  else
    execute format(
      'update public.%I t
          set custom_fields = jsonb_set(t.custom_fields, array[$1], to_jsonb($3::text))
        where t.organization_id = $4
          and t.custom_fields ->> $1 = $2',
      p_table
    ) using p_key, p_old, p_new, v_org;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.rename_option_value(text, text, boolean, text, text) from public;
revoke execute on function public.rename_custom_field_value(text, text, boolean, text, text) from public;

grant execute on function public.rename_option_value(text, text, boolean, text, text)
  to authenticated, service_role;
grant execute on function public.rename_custom_field_value(text, text, boolean, text, text)
  to authenticated, service_role;
