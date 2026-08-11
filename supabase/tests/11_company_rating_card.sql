-- =============================================================================
-- The Company Rating card.
--
--   A custom field is filed under a card, and which cards exist is a check
--   constraint rather than a list in the code. Adding "Company Rating" meant
--   rewriting that constraint, and a rewrite that drops a card by accident
--   would orphan every field filed under it.
--
--   So: the new card is accepted, the ones that came before it still are, and
--   a card nobody defined is still refused.
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

do $$
declare
  v_org  uuid;
  v_card text;
  v_failed boolean;
begin
  insert into organizations (name, slug) values ('Rating Co', 'rating-co') returning id into v_org;

  raise notice 'Cards a field may be filed under:';

  -- Every card the application offers, including the new one. A constraint
  -- rewrite that forgot one would fail here rather than in production.
  foreach v_card in array array['details', 'influence', 'additional', 'digital', 'pricing', 'rating']
  loop
    insert into custom_field_definitions (organization_id, entity_type, key, label, field_type, card)
    values (v_org, 'company', 'f_' || v_card, initcap(v_card), 'text', v_card);

    perform test_assert(
      exists (
        select 1 from custom_field_definitions
        where organization_id = v_org and key = 'f_' || v_card and card = v_card
      ),
      format('a field can be filed under %L', v_card)
    );
  end loop;

  v_failed := false;
  begin
    insert into custom_field_definitions (organization_id, entity_type, key, label, field_type, card)
    values (v_org, 'company', 'f_nonsense', 'Nonsense', 'text', 'nonsense');
  exception when check_violation then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'and a card nobody defined is still refused');
end;
$$;

-- =============================================================================
-- The fields that moved.
--
-- Stock type, regions and size were filed under Company info because that was
-- the only place to put them. The migration moves them; anything else a
-- company keeps on that card stays where it is.
-- =============================================================================
do $$
declare
  v_org uuid;
begin
  raise notice 'What the migration moved:';

  insert into organizations (name, slug) values ('Move Co', 'move-co') returning id into v_org;

  insert into custom_field_definitions (organization_id, entity_type, key, label, field_type, card)
  values
    (v_org, 'company', 'stock_type', 'Stock Type', 'multiselect', 'details'),
    (v_org, 'company', 'regions',    'Regions',    'multiselect', 'details'),
    (v_org, 'company', 'size',       'Size',       'select',      'details'),
    (v_org, 'company', 'vat_number', 'VAT number', 'text',        'details'),
    (v_org, 'contact', 'size',       'Size',       'text',        'details');

  -- The migration has already run against this database, so re-running its
  -- statement is what a second deploy would do: it must be idempotent and it
  -- must not reach past the three fields it was written for.
  update custom_field_definitions
  set card = 'rating'
  where entity_type = 'company'
    and card = 'details'
    and (
      lower(label) in ('stock type', 'stock types', 'regions', 'region', 'size')
      or lower(key) in ('stock_type', 'stock_types', 'regions', 'region', 'size')
    );

  perform test_assert(
    (select count(*) from custom_field_definitions
     where organization_id = v_org and entity_type = 'company' and card = 'rating') = 3,
    'stock type, regions and size move to the rating card'
  );

  perform test_assert(
    (select card from custom_field_definitions
     where organization_id = v_org and entity_type = 'company' and key = 'vat_number') = 'details',
    'a company field that is not one of them stays on Company info'
  );

  perform test_assert(
    (select card from custom_field_definitions
     where organization_id = v_org and entity_type = 'contact' and key = 'size') = 'details',
    'and a contact field of the same name is left alone — rating is a company card'
  );
end;
$$;

rollback;
