-- =============================================================================
-- Bulk field changes.
--
--   One statement writing to many rows is exactly where a permission mistake
--   stops being a small mistake. These tests hold three lines:
--
--     * a change reaches only rows the caller could already edit — the function
--       is SECURITY INVOKER so the ordinary row policies decide, and a
--       selection that includes somebody else's record silently skips it
--       rather than failing or, worse, succeeding;
--     * one organization can never touch another's, even by naming its ids;
--     * the field name is checked against a whitelist, so a column nobody
--       chose to expose cannot be written through it.
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

create or replace function sign_in_as(p_key text)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', (select id from fixture where key = p_key), 'role', 'authenticated')::text,
    true
  );
end;
$$;

grant execute on function sign_in_as(text) to authenticated;

/** Reads past RLS, so a test can check what actually happened to a row. */
create or replace function contact_owner(p_contact uuid)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select owner_id from contacts where id = p_contact;
$$;

create or replace function contact_roles(p_contact uuid)
returns text[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select role_type from contacts where id = p_contact;
$$;

create or replace function company_custom(p_company uuid, p_key text)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select custom_fields -> p_key from companies where id = p_company;
$$;

grant execute on function contact_owner(uuid) to authenticated;
grant execute on function contact_roles(uuid) to authenticated;
grant execute on function company_custom(uuid, text) to authenticated;

do $$
declare
  v_org      uuid;
  v_other    uuid;
  v_admin_a  uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_rep2_a   uuid := gen_random_uuid();
  v_badmin_a uuid := gen_random_uuid();
  v_admin    uuid;
  v_rep      uuid;
  v_rep2     uuid;
  v_badmin   uuid;
  v_c1       uuid;
  v_c2       uuid;
  v_c3       uuid;
  v_theirs   uuid;
  v_company  uuid;
  v_product  uuid;
begin
  insert into organizations (name, slug) values ('Bulk Co', 'bulk-co') returning id into v_org;
  insert into organizations (name, slug) values ('Other Bulk Co', 'other-bulk-co') returning id into v_other;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@bulk.test'),
    (v_rep_a, 'rep@bulk.test'),
    (v_rep2_a, 'rep2@bulk.test'),
    (v_badmin_a, 'admin@otherbulk.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@bulk.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@bulk.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep2@bulk.test', 'Rio', 'regular', v_rep2_a, 'active') returning id into v_rep2;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_other, 'admin@otherbulk.test', 'Bo', 'admin', v_badmin_a, 'active') returning id into v_badmin;

  insert into custom_field_definitions (organization_id, entity_type, key, label, field_type, card)
  values (v_org, 'company', 'regions', 'Regions', 'multiselect', 'rating');

  insert into contacts (organization_id, first_name, last_name, owner_id, role_type)
  values (v_org, 'One', 'Rep', v_rep, array['Champion']) returning id into v_c1;
  insert into contacts (organization_id, first_name, last_name, owner_id, role_type)
  values (v_org, 'Two', 'Rep', v_rep, '{}') returning id into v_c2;
  -- Owned by the other rep, so it is in the organization but out of Raj's reach.
  insert into contacts (organization_id, first_name, last_name, owner_id)
  values (v_org, 'Three', 'Rep2', v_rep2) returning id into v_c3;

  insert into contacts (organization_id, first_name, last_name, owner_id)
  values (v_other, 'Their', 'Contact', v_badmin) returning id into v_theirs;

  insert into companies (organization_id, name, owner_id)
  values (v_org, 'Bulk Client', v_admin) returning id into v_company;

  -- Org-wide reference data rather than anybody's record, which is the whole
  -- point of the product case below: its policy asks a different question.
  insert into products (organization_id, name, unit_price)
  values (v_org, 'Pallet of scrubs', 100) returning id into v_product;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_admin_a), ('rep_auth', v_rep_a), ('rep2_auth', v_rep2_a),
    ('badmin_auth', v_badmin_a),
    ('admin', v_admin), ('rep', v_rep), ('rep2', v_rep2),
    ('c1', v_c1), ('c2', v_c2), ('c3', v_c3), ('theirs', v_theirs),
    ('company', v_company), ('product', v_product);
end;
$$;

set local role authenticated;

-- =============================================================================
-- The ordinary case.
-- =============================================================================
do $$
declare
  v_changed integer;
begin
  raise notice 'Setting a field across several records:';
  perform sign_in_as('admin_auth');

  v_changed := bulk_update_records(
    'contact',
    array[(select id from fixture where key = 'c1'), (select id from fixture where key = 'c2')],
    'owner_id',
    'set',
    array[(select id from fixture where key = 'admin')::text]
  );

  perform test_assert(v_changed = 2, 'the count returned is the number of rows changed');
  perform test_assert(
    contact_owner((select id from fixture where key = 'c1')) = (select id from fixture where key = 'admin')
    and contact_owner((select id from fixture where key = 'c2')) = (select id from fixture where key = 'admin'),
    'both records took the new owner'
  );

  perform test_assert(
    bulk_update_records(
      'contact',
      array[(select id from fixture where key = 'c1')],
      'owner_id', 'clear', '{}'
    ) = 1,
    'and clearing a field empties it'
  );
  perform test_assert(
    contact_owner((select id from fixture where key = 'c1')) is null,
    'the owner is now nobody'
  );
end;
$$;

-- =============================================================================
-- Lists: replaced, added to, taken from.
-- =============================================================================
do $$
declare
  v_c1 uuid := (select id from fixture where key = 'c1');
begin
  raise notice 'Amending a list:';
  perform sign_in_as('admin_auth');

  perform bulk_update_records('contact', array[v_c1], 'role_type', 'set', array['Buyer', 'Champion']);
  perform test_assert(contact_roles(v_c1) = array['Buyer', 'Champion'], 'set replaces the list');

  perform bulk_update_records('contact', array[v_c1], 'role_type', 'add', array['Gatekeeper']);
  perform test_assert(
    contact_roles(v_c1) = array['Buyer', 'Champion', 'Gatekeeper'],
    'add appends, leaving the order somebody chose alone'
  );

  perform bulk_update_records('contact', array[v_c1], 'role_type', 'add', array['Buyer']);
  perform test_assert(
    contact_roles(v_c1) = array['Buyer', 'Champion', 'Gatekeeper'],
    'adding something already there changes nothing, rather than duplicating it'
  );

  perform bulk_update_records('contact', array[v_c1], 'role_type', 'remove', array['Champion']);
  perform test_assert(
    contact_roles(v_c1) = array['Buyer', 'Gatekeeper'],
    'remove takes out only what was named'
  );

  perform bulk_update_records('contact', array[v_c1], 'role_type', 'remove', array['Not on the list']);
  perform test_assert(
    contact_roles(v_c1) = array['Buyer', 'Gatekeeper'],
    'removing something absent is quietly nothing'
  );

  perform bulk_update_records('contact', array[v_c1], 'role_type', 'clear', '{}');
  perform test_assert(contact_roles(v_c1) = '{}', 'and clear empties it');
end;
$$;

-- =============================================================================
-- An organization's own fields.
-- =============================================================================
do $$
declare
  v_company uuid := (select id from fixture where key = 'company');
begin
  raise notice 'A custom field:';
  perform sign_in_as('admin_auth');

  perform bulk_update_records('company', array[v_company], 'custom_fields.regions', 'set', array['EMEA']);
  perform test_assert(
    company_custom(v_company, 'regions') = '"EMEA"'::jsonb,
    'one value is stored as a string, the way the record''s own form writes it'
  );

  perform bulk_update_records(
    'company', array[v_company], 'custom_fields.regions', 'set', array['EMEA', 'APAC']
  );
  perform test_assert(
    company_custom(v_company, 'regions') = '["EMEA", "APAC"]'::jsonb,
    'several are stored as a list'
  );

  perform bulk_update_records('company', array[v_company], 'custom_fields.regions', 'clear', '{}');
  perform test_assert(
    company_custom(v_company, 'regions') is null,
    'and clearing takes the key back out of the document'
  );
end;
$$;

-- =============================================================================
-- Products, which are not anybody's records.
--
-- A contact belongs to the rep who owns it; a product belongs to the desk. The
-- function is the same one and the whitelist is the same whitelist, so the only
-- thing standing between a rep and the price list is the products policy —
-- which is exactly what this checks, because widening a whitelist must not
-- widen a permission.
-- =============================================================================
do $$
declare
  v_product uuid := (select id from fixture where key = 'product');
  v_failed  boolean;
begin
  raise notice 'A product:';
  perform sign_in_as('admin_auth');

  perform test_assert(
    bulk_update_records('product', array[v_product], 'unit_price', 'set', array['250.00']) = 1,
    'a manager can reprice from the list'
  );
  perform test_assert(
    (select unit_price = 250.00 from products where id = v_product),
    'and the price lands'
  );

  perform test_assert(
    bulk_update_records('product', array[v_product], 'price_showroom', 'clear', '{}') = 1,
    'a derived price can be sent back to being derived'
  );
  perform test_assert(
    (select price_showroom is null from products where id = v_product),
    'which means the override going away rather than becoming zero'
  );

  v_failed := false;
  begin
    perform bulk_update_records('product', array[v_product], 'currency', 'set', array['USD']);
  exception when others then v_failed := true;
  end;
  perform test_assert(v_failed, 'the currency the prices are in is not on the list');

  -- The rep, whose policy does not let them write reference data at all.
  perform sign_in_as('rep_auth');
  perform test_assert(
    bulk_update_records('product', array[v_product], 'unit_price', 'set', array['1.00']) = 0,
    'a rep changes nothing, and is told so by the count rather than by an error'
  );
  perform test_assert(
    (select unit_price = 250.00 from products where id = v_product),
    'and the catalogue still says what the manager set'
  );
end;
$$;

-- =============================================================================
-- Reach. The heart of it.
-- =============================================================================
do $$
declare
  v_c1     uuid := (select id from fixture where key = 'c1');
  v_c3     uuid := (select id from fixture where key = 'c3');
  v_theirs uuid := (select id from fixture where key = 'theirs');
  v_rep    uuid := (select id from fixture where key = 'rep');
  v_before uuid;
  v_changed integer;
begin
  raise notice 'Whose records a change can reach:';

  -- Raj owns c1 and c2 but not c3. A selection naming all three must change
  -- only what Raj could have opened and edited by hand.
  perform sign_in_as('admin_auth');
  perform bulk_update_records('contact', array[v_c1], 'owner_id', 'set', array[v_rep::text]);
  v_before := contact_owner(v_c3);

  perform sign_in_as('rep_auth');
  v_changed := bulk_update_records(
    'contact', array[v_c1, v_c3], 'lifecycle_stage', 'set', array['qualified']
  );

  perform test_assert(v_changed = 1, 'a rep''s change reaches their own record and stops there');
  perform sign_in_as('admin_auth');
  perform test_assert(
    contact_owner(v_c3) = v_before,
    'the colleague''s record is untouched rather than refused — a stale selection is harmless'
  );

  -- The organization check inside the function, independent of RLS.
  perform sign_in_as('badmin_auth');
  perform test_assert(
    bulk_update_records('contact', array[v_c1], 'owner_id', 'clear', '{}') = 0,
    'another organization''s administrator changes nothing, even naming the id'
  );

  perform sign_in_as('admin_auth');
  perform test_assert(
    bulk_update_records('contact', array[v_theirs], 'owner_id', 'clear', '{}') = 0,
    'and cannot be reached in the other direction either'
  );
end;
$$;

-- =============================================================================
-- What may be written at all.
-- =============================================================================
do $$
declare
  v_c1    uuid := (select id from fixture where key = 'c1');
  v_failed boolean;
begin
  raise notice 'The whitelist:';
  perform sign_in_as('admin_auth');

  /*
   * lead_score rather than email, which the lists edit in place as of
   * 20260262 — a whitelist test has to name something that is still off the
   * list, and a score the rules derive is the clearest example of one: writing
   * it by hand would be overwritten the next time scoring ran.
   */
  v_failed := false;
  begin
    perform bulk_update_records('contact', array[v_c1], 'lead_score', 'set', array['99']);
  exception when others then v_failed := true;
  end;
  perform test_assert(v_failed, 'a column nobody chose to expose cannot be written');

  -- …and the ones that were added to it do work, on all three record types.
  perform test_assert(
    bulk_update_records('contact', array[v_c1], 'email', 'set', array['x@example.com']) = 1,
    'a contact''s email can be corrected from the list'
  );
  perform test_assert(
    bulk_update_records('contact', array[v_c1], 'job_title', 'set', array['Buyer']) = 1,
    'and so can a job title'
  );
  perform test_assert(
    (select email = 'x@example.com' and job_title = 'Buyer' from contacts where id = v_c1),
    'and both land on the row rather than being reported and dropped'
  );

  v_failed := false;
  begin
    perform bulk_update_records('contact', array[v_c1], 'organization_id', 'set', array[gen_random_uuid()::text]);
  exception when others then v_failed := true;
  end;
  perform test_assert(v_failed, 'least of all the one that decides which tenant a row belongs to');

  -- The reason the whitelist exists rather than quoting alone.
  v_failed := false;
  begin
    perform bulk_update_records(
      'contact', array[v_c1], 'owner_id = null where true; --', 'set', array['x']
    );
  exception when others then v_failed := true;
  end;
  perform test_assert(v_failed, 'and a field name carrying SQL is refused, not interpolated');

  v_failed := false;
  begin
    perform bulk_update_records('contact', array[v_c1], 'custom_fields.invented', 'set', array['x']);
  exception when others then v_failed := true;
  end;
  perform test_assert(v_failed, 'a custom field this organization never defined is refused');

  v_failed := false;
  begin
    perform bulk_update_records('deal', array[v_c1], 'owner_id', 'set', array['x']);
  exception when others then v_failed := true;
  end;
  perform test_assert(v_failed, 'and a record type that does not offer bulk editing is refused');

  v_failed := false;
  begin
    perform bulk_update_records('contact', array[v_c1], 'owner_id', 'sabotage', array['x']);
  exception when others then v_failed := true;
  end;
  perform test_assert(v_failed, 'as is a change nobody defined');
end;
$$;

-- =============================================================================
-- Edges.
-- =============================================================================
do $$
declare
  v_c1  uuid := (select id from fixture where key = 'c1');
  v_ids uuid[];
  v_failed boolean := false;
begin
  raise notice 'Edges:';
  perform sign_in_as('admin_auth');

  perform test_assert(
    bulk_update_records('contact', '{}', 'owner_id', 'clear', '{}') = 0,
    'an empty selection changes nothing and says so'
  );
  perform test_assert(
    bulk_update_records('contact', null, 'owner_id', 'clear', '{}') = 0,
    'and so does no selection at all'
  );

  select array_agg(gen_random_uuid()) into v_ids from generate_series(1, 501);
  begin
    perform bulk_update_records('contact', v_ids, 'owner_id', 'clear', '{}');
  exception when others then v_failed := true;
  end;
  perform test_assert(v_failed, 'a selection past the limit is refused rather than attempted');
end;
$$;

rollback;
