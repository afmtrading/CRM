-- =============================================================================
-- Company detail card tests.
--
-- Covers the company-side schema work: tags on companies (including the
-- cross-organization guard), created-by / updated-by stamping, and the move of
-- specialty market and customer type off the contact.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

create table fixture (key text primary key, id uuid);
grant select, insert on fixture to authenticated;

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

grant execute on function test_assert(boolean, text) to authenticated;

do $$
declare
  v_org_a  uuid;
  v_org_b  uuid;
  v_auth_a uuid := gen_random_uuid();
  v_user_a uuid;
begin
  insert into organizations (name, slug) values ('Co A', 'co-a') returning id into v_org_a;
  insert into organizations (name, slug) values ('Co B', 'co-b') returning id into v_org_b;

  insert into auth.users (id, email) values (v_auth_a, 'a@co.test');
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org_a, 'a@co.test', 'Ada', 'admin', v_auth_a, 'active') returning id into v_user_a;

  insert into fixture values ('org_a', v_org_a), ('org_b', v_org_b),
    ('auth_a', v_auth_a), ('user_a', v_user_a);
end;
$$;

-- =============================================================================
-- The moved fields now live on the company, not the contact.
-- =============================================================================
do $$
begin
  raise notice 'Field placement:';

  perform test_assert(
    not exists (
      select 1 from information_schema.columns
      where table_name = 'contacts' and column_name in ('specialty_market', 'customer_type')
    ),
    'specialty market and customer type are gone from contacts'
  );

  perform test_assert(
    (select count(*) from information_schema.columns
     where table_name = 'companies' and column_name in ('specialty_market', 'customer_type')) = 2,
    'specialty market and customer type are on companies'
  );

  perform test_assert(
    (select count(*) from information_schema.columns
     where table_name = 'companies'
       and column_name in ('phone', 'email', 'linkedin', 'facebook', 'instagram',
                           'tiktok', 'x_twitter', 'links', 'addresses')) = 9,
    'the company gains its contact, digital and address columns'
  );

  perform test_assert(
    exists (select 1 from information_schema.columns
      where table_name = 'contacts' and column_name = 'linkedin'),
    'a contact keeps its own LinkedIn'
  );
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', (select id from fixture where key = 'auth_a'), 'role', 'authenticated')::text,
  true
);

-- =============================================================================
-- Company record history.
-- =============================================================================
do $$
declare
  v_org_a   uuid := (select id from fixture where key = 'org_a');
  v_user_a  uuid := (select id from fixture where key = 'user_a');
  v_company uuid;
begin
  raise notice 'Company record:';

  insert into companies (organization_id, name, domain)
  values (v_org_a, 'Northbay Foods', 'northbay.co')
  returning id into v_company;

  insert into fixture values ('company', v_company);

  perform test_assert(
    (select created_by from companies where id = v_company) = v_user_a,
    'creating a company records who created it'
  );

  perform test_assert(
    (select addresses from companies where id = v_company) = '[]'::jsonb
    and (select links from companies where id = v_company) = '[]'::jsonb,
    'addresses and links start empty'
  );

  update companies
  set specialty_market = array['Foodservice', 'Retail'],
      customer_type = array['Distributor'],
      addresses = '[{"label":"Head office","address":"1 Bay St, Toronto"}]'::jsonb
  where id = v_company;

  perform test_assert(
    (select specialty_market from companies where id = v_company) = array['Foodservice', 'Retail'],
    'a company holds multiple specialty markets'
  );

  perform test_assert(
    (select jsonb_array_length(addresses) from companies where id = v_company) = 1,
    'a company holds a labelled address'
  );

  perform test_assert(
    (select updated_by from companies where id = v_company) = v_user_a,
    'editing a company records the editor'
  );
end;
$$;

-- =============================================================================
-- Tags on companies, and the cross-organization guard.
-- =============================================================================
do $$
declare
  v_org_a   uuid := (select id from fixture where key = 'org_a');
  v_company uuid := (select id from fixture where key = 'company');
  v_tag     uuid;
begin
  raise notice 'Company tags:';

  insert into tags (organization_id, name, color) values (v_org_a, 'Key account', '#10b981')
  returning id into v_tag;
  insert into fixture values ('tag_a', v_tag);

  insert into company_tags (company_id, tag_id) values (v_company, v_tag);

  perform test_assert(
    (select organization_id from company_tags where company_id = v_company and tag_id = v_tag) = v_org_a,
    'the join row is stamped with the company''s organization automatically'
  );

  perform test_assert(
    (select count(*) from company_tags where company_id = v_company) = 1,
    'a company carries its tag'
  );
end;
$$;

-- A tag from another organization must be refused, even though the caller
-- cannot see that tag at all — the guard is in the database, not the UI.
do $$
declare
  v_org_b   uuid := (select id from fixture where key = 'org_b');
  v_company uuid := (select id from fixture where key = 'company');
  v_foreign uuid;
  v_failed  boolean := false;
begin
  set local role postgres;
  insert into tags (organization_id, name, color) values (v_org_b, 'Theirs', '#ef4444')
  returning id into v_foreign;

  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', (select id from fixture where key = 'auth_a'), 'role', 'authenticated')::text,
    true
  );

  begin
    insert into company_tags (company_id, tag_id) values (v_company, v_foreign);
  exception when others then
    v_failed := true;
  end;

  perform test_assert(v_failed, 'tagging a company with another organization''s tag is refused');
end;
$$;

-- Deleting a company takes its tag links with it, rather than leaving rows
-- pointing at nothing.
do $$
declare
  v_org_a   uuid := (select id from fixture where key = 'org_a');
  v_tag     uuid := (select id from fixture where key = 'tag_a');
  v_temp    uuid;
begin
  insert into companies (organization_id, name) values (v_org_a, 'Temp Co') returning id into v_temp;
  insert into company_tags (company_id, tag_id) values (v_temp, v_tag);

  delete from companies where id = v_temp;

  perform test_assert(
    (select count(*) from company_tags where company_id = v_temp) = 0,
    'deleting a company removes its tag links'
  );
end;
$$;

-- =============================================================================
-- Isolation: a company in another organization stays invisible.
-- =============================================================================
do $$
declare
  v_org_b uuid := (select id from fixture where key = 'org_b');
  v_theirs uuid;
begin
  set local role postgres;
  insert into companies (organization_id, name) values (v_org_b, 'Their Co') returning id into v_theirs;
  insert into fixture values ('their_company', v_theirs);

  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', (select id from fixture where key = 'auth_a'), 'role', 'authenticated')::text,
    true
  );

  perform test_assert(
    (select count(*) from companies where id = v_theirs) = 0,
    'another organization''s company is not readable'
  );

  perform test_assert(
    (select count(*) from company_tags where organization_id = v_org_b) = 0,
    'another organization''s company tags are not readable'
  );
end;
$$;

-- =============================================================================
-- Custom fields and option lists share one mechanism.
-- =============================================================================
do $$
declare
  v_org_a uuid := (select id from fixture where key = 'org_a');
  v_field uuid;
begin
  raise notice 'Unified option lists:';

  set local role postgres;

  insert into custom_field_definitions (organization_id, entity_type, key, label, field_type, card)
  values (v_org_a, 'contact', 'region', 'Region', 'multiselect', 'details')
  returning id into v_field;

  insert into field_options (organization_id, entity_type, field_key, value, color, "order")
  values (v_org_a, 'contact', 'region', 'EMEA', 'blue', 1),
         (v_org_a, 'contact', 'region', 'APAC', 'green', 2);

  perform test_assert(
    (select count(*) from field_options
      where organization_id = v_org_a and entity_type = 'contact' and field_key = 'region') = 2,
    'a custom field stores its options in the same table as the built-in fields'
  );

  -- A contact and a company may each define a "region" field; they are
  -- different fields and must not share one list.
  insert into field_options (organization_id, entity_type, field_key, value, color, "order")
  values (v_org_a, 'company', 'region', 'Ontario', 'amber', 1);

  perform test_assert(
    (select count(*) from field_options
      where organization_id = v_org_a and entity_type = 'company' and field_key = 'region') = 1,
    'the same key on a different record type keeps its own list'
  );

  -- Renaming the field carries its options across.
  update custom_field_definitions set key = 'territory' where id = v_field;

  perform test_assert(
    (select count(*) from field_options
      where organization_id = v_org_a and entity_type = 'contact' and field_key = 'territory') = 2,
    'renaming a custom field moves its options with it'
  );

  perform test_assert(
    (select count(*) from field_options
      where organization_id = v_org_a and entity_type = 'contact' and field_key = 'region') = 0,
    'nothing is left behind under the old key'
  );

  perform test_assert(
    (select count(*) from field_options
      where organization_id = v_org_a and entity_type = 'company' and field_key = 'region') = 1,
    'the company list of the same name is untouched by the rename'
  );

  -- Deleting the field takes its options with it rather than orphaning them.
  delete from custom_field_definitions where id = v_field;

  perform test_assert(
    (select count(*) from field_options
      where organization_id = v_org_a and entity_type = 'contact' and field_key = 'territory') = 0,
    'deleting a custom field removes its options'
  );
end;
$$;

-- The built-in lists now carry the record type they describe.
do $$
declare
  v_org_a uuid := (select id from fixture where key = 'org_a');
begin
  perform test_assert(
    (select distinct entity_type::text from field_options
      where organization_id = v_org_a and field_key = 'specialty_market') = 'company',
    'specialty market options belong to the company'
  );

  /*
   * Priority was the contact's alone when this was written. It is now asked of
   * three record types, each with a list of its own — a Critical account can
   * hold a Standard line, and one shared list would make those the same
   * statement. What matters is still that every option names a record type.
   */
  perform test_assert(
    (select array_agg(distinct entity_type::text order by entity_type::text)
       from field_options
      where organization_id = v_org_a and field_key = 'priority')
      = array['company', 'contact', 'product'],
    'priority is asked of a contact, a company and a product, each from its own list'
  );
end;
$$;

rollback;
