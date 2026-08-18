-- =============================================================================
-- One Stock type, not two
--
-- A company record was showing "Stock type" twice: the built-in column, which
-- 20260238 added and the filters and the list column read, and a custom field
-- of the same name that an organization had defined for itself. Two rows, one
-- question, and no way to tell from the card which one anything else was
-- looking at.
--
-- The built-in wins, because it is the one the rest of the app uses. The custom
-- field's answers are merged into it first rather than dropped — the whole
-- reason to do this in a migration instead of asking somebody to delete the
-- field in Settings, which would take the answers with it.
--
-- Matched by name, like the Region retirement in 20260251: a custom field has
-- no stable identity across organizations, only what somebody called it.
-- =============================================================================

do $$
declare
  v_field   record;
  v_company record;
  v_values  text[];
begin
  for v_field in
    select id, organization_id, key, label
    from public.custom_field_definitions
    where entity_type = 'company'
      and btrim(label) ~* '^stock[ _-]?types?$'
  loop
    /*
     * Merged, not overwritten. A company answering both keeps the union: the
     * built-in is what the filters read, so a value only the custom field knew
     * about would otherwise stop being findable.
     */
    for v_company in
      select id, stock_type, custom_fields -> v_field.key as held
      from public.companies
      where organization_id = v_field.organization_id
        and custom_fields ? v_field.key
    loop
      -- A single-select stores a string and a multi-select an array.
      v_values := case jsonb_typeof(v_company.held)
        when 'array' then array(select jsonb_array_elements_text(v_company.held))
        when 'string' then array[v_company.held #>> '{}']
        else '{}'::text[]
      end;

      v_values := array(
        select distinct btrim(value)
        from unnest(coalesce(v_company.stock_type, '{}') || v_values) as value
        where btrim(value) <> ''
      );

      update public.companies set stock_type = v_values where id = v_company.id;
    end loop;

    /*
     * Whatever the custom field offered becomes an option on the built-in list,
     * so a merged value renders as a badge rather than as an unknown and can be
     * chosen again from the form.
     */
    insert into public.field_options (organization_id, entity_type, field_key, value, color, "order")
    select
      v_field.organization_id,
      'company',
      'stock_type',
      old.value,
      old.color,
      old."order"
    from public.field_options old
    where old.organization_id = v_field.organization_id
      and old.entity_type = 'company'
      and old.field_key = v_field.key
    on conflict do nothing;

    -- The question goes, now that its answers have somewhere to live.
    update public.companies
    set custom_fields = custom_fields - v_field.key
    where organization_id = v_field.organization_id
      and custom_fields ? v_field.key;

    delete from public.field_options
    where organization_id = v_field.organization_id
      and entity_type = 'company'
      and field_key = v_field.key;

    delete from public.custom_field_definitions where id = v_field.id;

    raise notice 'Stock type: merged and removed the duplicate company field %', v_field.key;
  end loop;
end;
$$;
