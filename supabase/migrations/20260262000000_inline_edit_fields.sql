-- =============================================================================
-- The fields a list may change without opening the record
--
-- Editing a cell in place goes through `bulk_update_records` with one id — the
-- same function the bulk bar uses, so there is one whitelist of what may be
-- written from a list rather than two that can drift. This widens that list to
-- what the desk actually corrects while reading a list, and adds the third
-- record type that had none of it.
--
-- WHAT IS ADDED, AND WHY EACH ONE
--
-- Contacts gain job_title, email and phone. Companies gain email and phone, and
-- stock_type joins the two arrays already there. These are the fields somebody
-- fixes while looking at a list — a number that bounced, an address that came
-- back, a title that changed — and every one of them meant opening the record,
-- editing a form and pressing Save.
--
-- Products arrive whole: status, category, condition, priority, brand, sku, and
-- the four prices. A catalogue is repriced and re-graded far more often than a
-- contact is re-titled, and until now none of it could be done from the list.
--
-- WHAT IS STILL NOT HERE, DELIBERATELY
--
-- A name, a lead score, a currency, an organization_id. A name is what a row is
-- recognised by and is not something to change by mistyping into a table; a
-- lead score is derived by the scoring rules and would be overwritten by them;
-- currency belongs with the prices it denominates, and changing it alone would
-- silently re-denominate a whole catalogue. organization_id is the tenant
-- boundary and appears on no list at any level.
--
-- WHAT THIS FUNCTION STILL IS
--
-- INVOKER, not definer, so the row-level policies decide which of the named ids
-- the change actually reaches. Products are org-wide reference data and their
-- policy requires `can_manage_records()`, so a rep who can edit their own
-- contacts still cannot reprice the catalogue — the whitelist widens, the
-- permissions do not.
--
-- Recreated from the live definition with two hunks changed: the entity-to-
-- table map, and the whitelist itself. Rebuilding it from memory is how a
-- function quietly loses its search_path.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.bulk_update_records(p_entity text, p_ids uuid[], p_field text, p_mode text, p_values text[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  if array_length(p_ids, 1) > 500 then
    raise exception 'Too many records in one change (limit 500)';
  end if;

  if p_mode not in ('set', 'add', 'remove', 'clear') then
    raise exception 'Unknown change %', p_mode;
  end if;

  v_table := case p_entity
    when 'contact' then 'contacts'
    when 'company' then 'companies'
    when 'product' then 'products'
    else null
  end;

  if v_table is null then
    raise exception 'Cannot bulk edit %', p_entity;
  end if;

  if p_field like 'custom_fields.%' then
    v_key := substring(p_field from 15);

    if not exists (
      select 1 from public.custom_field_definitions
      where organization_id = v_org
        and entity_type::text = p_entity
        and key = v_key
    ) then
      raise exception 'No such field %', v_key;
    end if;

    v_kind := 'json';
  elsif p_entity = 'contact' and p_field in
    ('owner_id', 'company_id', 'lifecycle_stage', 'priority', 'credibility', 'hidden',
     'mailable_override', 'job_title', 'email', 'phone')
  then
    v_kind := 'scalar';
  elsif p_entity = 'contact' and p_field = 'role_type' then
    v_kind := 'array';
  elsif p_entity = 'company' and p_field in
    ('owner_id', 'hidden', 'priority', 'email', 'phone')
  then
    v_kind := 'scalar';
  elsif p_entity = 'company' and p_field in
    ('specialty_market', 'customer_type', 'stock_type')
  then
    v_kind := 'array';
  elsif p_entity = 'product' and p_field in
    ('status', 'category', 'product_condition', 'priority', 'brand', 'sku',
     'unit_price', 'unit_cost', 'price_showroom', 'price_wholesale')
  then
    v_kind := 'scalar';
  else
    raise exception 'Field % cannot be changed in bulk', p_field;
  end if;

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
$function$;
-- The grant is unchanged — the signature has not moved — but it is restated so
-- this file stands alone as the definition of who may call this.
revoke execute on function public.bulk_update_records(text, uuid[], text, text, text[]) from public;

grant execute on function public.bulk_update_records(text, uuid[], text, text, text[])
  to authenticated, service_role;
