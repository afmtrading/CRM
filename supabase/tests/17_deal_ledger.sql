-- =============================================================================
-- The deal ledger.
--
--   Every deal, whatever its status. A ledger that hides what closed is not a
--   ledger.
--
--   Margin is NULL, not zero, for a deal priced by hand — there is nothing to
--   derive a cost from, and zero would read as "full margin".
--
--   Invoker, not definer: reporting must not become a way around the rule that
--   a sales rep sees only their own deals.
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

do $$
declare
  v_org      uuid;
  v_other    uuid;
  v_admin_a  uuid := gen_random_uuid();
  v_mgr_a    uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_rep2_a   uuid := gen_random_uuid();
  v_admin    uuid;
  v_mgr      uuid;
  v_rep      uuid;
  v_rep2     uuid;
  v_pipeline uuid;
  v_stage    uuid;
  v_won      uuid;
  v_speaker  uuid;
  v_cable    uuid;
  v_company  uuid;
  v_contact  uuid;
  v_costed   uuid;
  v_byhand   uuid;
  v_theirs   uuid;
begin
  insert into organizations (name, slug) values ('Ledger Co', 'ledger-report') returning id into v_org;
  insert into organizations (name, slug) values ('Rival Co', 'rival-report') returning id into v_other;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@ledger.test'),
    (v_mgr_a, 'mgr@ledger.test'),
    (v_rep_a, 'rep@ledger.test'),
    (v_rep2_a, 'rep2@ledger.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@ledger.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'mgr@ledger.test', 'Mo', 'manager', v_mgr_a, 'active') returning id into v_mgr;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@ledger.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep2@ledger.test', 'Rita', 'regular', v_rep2_a, 'active') returning id into v_rep2;

  insert into pipelines (organization_id, name, is_default)
  values (v_org, 'Quotes', false) returning id into v_pipeline;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_pipeline, 'Quote', 0, 0.500) returning id into v_stage;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability, outcome)
  values (v_org, v_pipeline, 'Won', 1, 1, 'won') returning id into v_won;

  insert into products (organization_id, name, unit_price, unit_cost)
  values (v_org, 'Speaker', 100, 60) returning id into v_speaker;
  insert into products (organization_id, name, unit_price, unit_cost)
  values (v_org, 'Cable', 10, 4) returning id into v_cable;

  -- The company carries the regions, as a multiselect custom field.
  insert into companies (organization_id, name, custom_fields)
  values (v_org, 'ACME', '{"regions": ["Ontario", "Quebec"]}'::jsonb) returning id into v_company;

  insert into contacts (organization_id, first_name, last_name, company_id, owner_id)
  values (v_org, 'Dana', 'Reed', v_company, v_rep) returning id into v_contact;

  -- A deal with line items: revenue, cost and margin can all be derived.
  insert into deals (organization_id, name, stage_id, value, currency, owner_id, company_id, contact_id)
  values (v_org, 'Costed order', v_stage, 0, 'USD', v_rep, v_company, v_contact)
  returning id into v_costed;

  insert into deal_products (organization_id, deal_id, product_id, quantity, unit_price, unit_cost)
  values (v_org, v_costed, v_speaker, 10, 100, 60),
         (v_org, v_costed, v_cable, 5, 10, 4);

  -- A deal priced by hand: no lines, so no cost exists anywhere.
  insert into deals (organization_id, name, stage_id, value, currency, owner_id, company_id)
  values (v_org, 'Hand priced', v_stage, 5000, 'CAD', v_rep, v_company)
  returning id into v_byhand;

  -- Somebody else's deal, for the visibility test.
  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Rita''s deal', v_stage, 700, 'USD', v_rep2)
  returning id into v_theirs;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('admin_auth', v_admin_a), ('mgr_auth', v_mgr_a),
    ('rep_auth', v_rep_a), ('rep2_auth', v_rep2_a),
    ('admin', v_admin), ('mgr', v_mgr), ('rep', v_rep), ('rep2', v_rep2),
    ('pipeline', v_pipeline), ('stage', v_stage), ('won_stage', v_won),
    ('speaker', v_speaker), ('cable', v_cable),
    ('company', v_company), ('contact', v_contact),
    ('costed', v_costed), ('byhand', v_byhand), ('theirs', v_theirs);
end;
$$;

set local role authenticated;

-- =============================================================================
-- What one row says.
-- =============================================================================
do $$
declare
  v_costed uuid := (select id from fixture where key = 'costed');
  v_row    record;
begin
  raise notice 'The ledger row:';

  perform sign_in_as('mgr_auth');

  select * into v_row from public.deal_ledger('regions') where deal_id = v_costed;

  perform test_assert(v_row.name = 'Costed order', 'the deal is there');
  perform test_assert(v_row.owner_name = 'Raj', 'with the owner resolved to a name');
  perform test_assert(v_row.pipeline_name = 'Quotes', 'and its pipeline');
  perform test_assert(v_row.stage_name = 'Quote', 'and its stage');
  perform test_assert(v_row.company_name = 'ACME', 'and its company');
  perform test_assert(v_row.contact_name = 'Dana Reed', 'and its contact, as one name');

  -- 10 x 100 + 5 x 10 = 1050 revenue; 10 x 60 + 5 x 4 = 620 cost.
  perform test_assert(v_row.revenue = 1050, 'revenue is summed from the line items');
  perform test_assert(v_row.cost = 620, 'and so is cost');
  perform test_assert(v_row.margin = 430, 'so the margin is real, not a guess');
  perform test_assert(v_row.line_count = 2, 'and it says how many lines it came from');
  perform test_assert(v_row.costed_lines = 2, 'and how many of them carried a cost');

  -- deals.value follows the line items, so weighted follows from that.
  perform test_assert(v_row.value = 1050, 'the deal value follows its lines');
  perform test_assert(
    v_row.weighted_value = round(v_row.value * v_row.probability, 2),
    'weighted value is value x probability — a forecast, not a result'
  );

  perform test_assert(
    v_row.products @> array['Speaker', 'Cable'],
    'the products on the deal are listed'
  );
  perform test_assert(
    v_row.regions @> array['Ontario', 'Quebec'],
    'and the regions carried by its company'
  );

  perform test_assert(v_row.cycle_days is null, 'an open deal has taken no time to close yet');
end;
$$;

-- =============================================================================
-- Unknown is not zero.
-- =============================================================================
do $$
declare
  v_byhand uuid := (select id from fixture where key = 'byhand');
  v_row    record;
begin
  raise notice 'A deal priced by hand:';

  perform sign_in_as('mgr_auth');
  select * into v_row from public.deal_ledger('regions') where deal_id = v_byhand;

  perform test_assert(v_row.value = 5000, 'keeps the value somebody typed');
  perform test_assert(v_row.revenue is null, 'has no revenue to derive');
  perform test_assert(v_row.cost is null, 'and no cost');
  perform test_assert(
    v_row.margin is null,
    'so its margin is unknown — zero would read as full margin on an uncosted deal'
  );
  perform test_assert(v_row.line_count = 0, 'and it says why: there are no lines');
  perform test_assert(v_row.products = array[]::text[], 'no products either, rather than a null');
end;
$$;

-- =============================================================================
-- Closed deals stay. Deleted deals do not.
-- =============================================================================
do $$
declare
  v_costed uuid := (select id from fixture where key = 'costed');
  v_byhand uuid := (select id from fixture where key = 'byhand');
  v_won    uuid := (select id from fixture where key = 'won_stage');
  v_row    record;
begin
  raise notice 'What stays in the ledger:';

  perform sign_in_as('mgr_auth');

  perform test_assert(
    (select count(*) from public.deal_ledger('regions')) = 3,
    'every deal is in the ledger to begin with'
  );

  update deals set stage_id = v_won where id = v_costed;

  perform test_assert(
    (select count(*) from public.deal_ledger('regions')) = 3,
    'winning a deal does not remove it — the whole point of a ledger'
  );

  select * into v_row from public.deal_ledger('regions') where deal_id = v_costed;
  perform test_assert(v_row.status = 'won', 'it is simply marked won');
  perform test_assert(v_row.closed_owner_name = 'Raj', 'with the owner it was won by');
  perform test_assert(v_row.cycle_days = 0, 'and how long it took, now that it has closed');

  -- Deleting is different from closing: the bin is not a report.
  perform sign_in_as('rep_auth');
  perform public.soft_delete_deal(v_byhand);

  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select count(*) from public.deal_ledger('regions')) = 2,
    'a deleted deal leaves the ledger'
  );

  -- Put it back, so the visibility tests below count what they expect to.
  perform sign_in_as('admin_auth');
  perform public.restore_deal(v_byhand);
end;
$$;

-- =============================================================================
-- Reporting is not a way around who sees what.
-- =============================================================================
do $$
declare
  v_theirs uuid := (select id from fixture where key = 'theirs');
begin
  raise notice 'Who sees which rows:';

  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select count(*) from public.deal_ledger('regions') where deal_id = v_theirs) = 1,
    'a manager sees the whole organization'
  );

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from public.deal_ledger('regions') where deal_id = v_theirs) = 0,
    'a rep does not see a colleague''s deal — the ledger is invoker, not definer'
  );
  -- Raj owns two of the three: the costed order and the hand-priced one.
  perform test_assert(
    (select count(*) from public.deal_ledger('regions')) = 2,
    'and sees their own, which is exactly what the deals policy already said'
  );
end;
$$;

-- =============================================================================
-- The region key is the organization's business, not this function's.
-- =============================================================================
do $$
declare
  v_costed uuid := (select id from fixture where key = 'costed');
begin
  raise notice 'Regions:';

  perform sign_in_as('mgr_auth');

  perform test_assert(
    (select cardinality(regions) from public.deal_ledger(null) where deal_id = v_costed) = 0,
    'no region field configured means no regions, not an error'
  );

  perform test_assert(
    (select cardinality(regions) from public.deal_ledger('not_a_field') where deal_id = v_costed) = 0,
    'and a key that matches nothing is empty rather than a failure'
  );

  -- A select rather than a multiselect stores a bare string; both are read.
  update companies set custom_fields = '{"territory": "Atlantic"}'::jsonb
  where id = (select id from fixture where key = 'company');

  perform test_assert(
    (select regions from public.deal_ledger('territory') where deal_id = v_costed)
      = array['Atlantic'],
    'a single-value region field is read as a list of one'
  );
end;
$$;

rollback;
