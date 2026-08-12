-- =============================================================================
-- Changing one field across many records at once
--
-- Reassigning forty contacts to a colleague meant opening forty records. This
-- does it in one statement.
--
-- Two decisions hold the whole thing up:
--
--   1. The function is SECURITY INVOKER — the default, stated here because it
--      is load-bearing rather than incidental. Every row it touches has to pass
--      the same row-level policy an ordinary edit would, so a rep cannot reach
--      a record in bulk that they could not reach one at a time, and nothing
--      here re-implements permissions that already exist.
--
--   2. The column name is dynamic, so it is checked against a whitelist before
--      it reaches format(). A field not on the list is refused rather than
--      interpolated, which is what keeps dynamic SQL from being an injection.
--
-- The `updated_by` triggers fire as they would for any other update, so a bulk
-- change is as auditable as a typed one.
-- =============================================================================

do $$
begin
  if to_regprocedure('public.current_org_id()') is null then
    raise exception 'Run the earlier migrations first — this one builds on current_org_id().';
  end if;
end
$$;

/**
 * Applies one change to one field across many records.
 *
 * p_entity  'contact' or 'company'
 * p_ids     the records to change; anything the caller cannot see is skipped
 *           by RLS rather than refused, so a stale selection is harmless
 * p_field   a column name, or 'custom_fields.<key>' for an organization's own
 * p_mode    'set' replaces, 'add' and 'remove' amend a list, 'clear' empties
 * p_values  the values; a scalar field reads the first, a list reads them all
 *
 * Returns the number of rows actually changed, which is what the caller should
 * report — it is the count after RLS, not the size of the selection.
 */
create or replace function public.bulk_update_records(
  p_entity text,
  p_ids uuid[],
  p_field text,
  p_mode text,
  p_values text[]
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_org    uuid := public.current_org_id();
  v_table  text;
  v_kind   text;
  v_key    text;
  v_type   text;
  v_values text[] := coalesce(p_values, '{}');
  v_count  integer;
begin
  if v_org is null then
    raise exception 'No organization in context';
  end if;

  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  -- A bound rather than a guess: the lists that feed this are capped at 200 a
  -- page, and a request for thousands is a bug or an attack, not a day's work.
  if array_length(p_ids, 1) > 500 then
    raise exception 'Too many records in one change (limit 500)';
  end if;

  if p_mode not in ('set', 'add', 'remove', 'clear') then
    raise exception 'Unknown change %', p_mode;
  end if;

  v_table := case p_entity
    when 'contact' then 'contacts'
    when 'company' then 'companies'
    else null
  end;

  if v_table is null then
    raise exception 'Cannot bulk edit %', p_entity;
  end if;

  -- ---------------------------------------------------------------------
  -- Which fields may be changed this way, and how each behaves.
  --
  -- Deliberately not every column. A name is not something anybody sets forty
  -- of at once, and an email address certainly is not; this is the list of
  -- fields that describe a record's place in the business rather than its
  -- identity.
  -- ---------------------------------------------------------------------
  if p_field like 'custom_fields.%' then
    v_key := substring(p_field from 15);

    -- The key has to be one this organization actually defined. Without this
    -- check a caller could write arbitrary keys into the JSON.
    if not exists (
      select 1 from public.custom_field_definitions
      where organization_id = v_org
        -- entity_type is an enum; compared as text so an unknown p_entity is a
        -- miss rather than a cast error.
        and entity_type::text = p_entity
        and key = v_key
    ) then
      raise exception 'No such field %', v_key;
    end if;

    v_kind := 'json';
  elsif p_entity = 'contact' and p_field in
    ('owner_id', 'company_id', 'lifecycle_stage', 'priority', 'credibility')
  then
    v_kind := 'scalar';
  elsif p_entity = 'contact' and p_field = 'role_type' then
    v_kind := 'array';
  elsif p_entity = 'company' and p_field = 'owner_id' then
    v_kind := 'scalar';
  elsif p_entity = 'company' and p_field in ('specialty_market', 'customer_type') then
    v_kind := 'array';
  else
    raise exception 'Field % cannot be changed in bulk', p_field;
  end if;

  -- ---------------------------------------------------------------------
  -- The statement itself. Identifiers come from the branches above, never
  -- from the argument, and the cast type comes from the catalogue.
  -- ---------------------------------------------------------------------
  if v_kind = 'scalar' then
    select format_type(a.atttypid, a.atttypmod)
    into v_type
    from pg_attribute a
    where a.attrelid = format('public.%I', v_table)::regclass
      and a.attname = p_field
      and a.attnum > 0;

    execute format(
      'update public.%I set %I = nullif($1, '''')::%s
       where id = any($2) and organization_id = $3',
      v_table, p_field, v_type
    )
    using case when p_mode = 'clear' then '' else coalesce(v_values[1], '') end, p_ids, v_org;

  elsif v_kind = 'array' then
    if p_mode = 'clear' then
      execute format(
        'update public.%I set %I = ''{}''::text[]
         where id = any($1) and organization_id = $2',
        v_table, p_field
      ) using p_ids, v_org;

    elsif p_mode = 'set' then
      execute format(
        'update public.%I set %I = $1
         where id = any($2) and organization_id = $3',
        v_table, p_field
      ) using v_values, p_ids, v_org;

    elsif p_mode = 'add' then
      -- Appended rather than merged and sorted, so a list somebody arranged by
      -- hand keeps its order and only gains what it was missing.
      execute format(
        'update public.%I set %I = coalesce(%I, ''{}'') || (
           select coalesce(array_agg(v), ''{}'')
           from unnest($1) v
           where not (v = any(coalesce(%I, ''{}'')))
         )
         where id = any($2) and organization_id = $3',
        v_table, p_field, p_field, p_field
      ) using v_values, p_ids, v_org;

    else
      execute format(
        'update public.%I set %I = (
           select coalesce(array_agg(v), ''{}'')
           from unnest(coalesce(%I, ''{}'')) v
           where not (v = any($1))
         )
         where id = any($2) and organization_id = $3',
        v_table, p_field, p_field
      ) using v_values, p_ids, v_org;
    end if;

  else
    /*
     * Custom fields are one key inside a JSON document, so the whole document
     * is rewritten with that key replaced — jsonb_set does that in place
     * without reading the row out first.
     *
     * Only set and clear. Add and remove would mean amending a list nested in
     * JSON, which is a great deal of SQL for a case nobody has asked for; a
     * multi-value custom field is replaced wholesale instead.
     */
    if p_mode = 'clear' then
      execute format(
        'update public.%I set custom_fields = coalesce(custom_fields, ''{}''::jsonb) - $1
         where id = any($2) and organization_id = $3',
        v_table
      ) using v_key, p_ids, v_org;

    elsif p_mode = 'set' then
      execute format(
        'update public.%I
         set custom_fields = jsonb_set(coalesce(custom_fields, ''{}''::jsonb), array[$1], $2, true)
         where id = any($3) and organization_id = $4',
        v_table
      ) using
        v_key,
        case
          when array_length(v_values, 1) is null then '""'::jsonb
          -- One value is stored as a string and several as an array, matching
          -- how the record's own form writes select and multi-select fields.
          when array_length(v_values, 1) = 1 then to_jsonb(v_values[1])
          else to_jsonb(v_values)
        end,
        p_ids,
        v_org;

    else
      raise exception 'A custom field can only be set or cleared, not %', p_mode;
    end if;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function public.bulk_update_records(text, uuid[], text, text, text[]) from public;
grant execute on function public.bulk_update_records(text, uuid[], text, text, text[])
  to authenticated, service_role;
