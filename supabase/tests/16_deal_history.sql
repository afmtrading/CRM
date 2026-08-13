-- =============================================================================
-- Deals as a permanent record.
--
--   Deleting a deal stamps it instead of destroying it, and only an
--   administrator can see or restore what is in the bin.
--
--   A deleted deal stops counting: it releases the stock it had committed and
--   leaves the pipeline report. This is the same class of bug as the Won stage
--   that did not mark deals won — a row that has left the working set but is
--   still being added up somewhere.
--
--   Closing a deal stamps who owned it. Handing the account to somebody else
--   afterwards does not move the win with it.
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
  v_org       uuid;
  v_admin_a   uuid := gen_random_uuid();
  v_mgr_a     uuid := gen_random_uuid();
  v_rep_a     uuid := gen_random_uuid();
  v_admin     uuid;
  v_mgr       uuid;
  v_rep       uuid;
  v_pipeline  uuid;
  v_stage     uuid;
  v_won       uuid;
  v_product   uuid;
  v_toronto   uuid;
  v_deal      uuid;
  v_spare     uuid;
begin
  insert into organizations (name, slug) values ('Ledger Co', 'ledger-co') returning id into v_org;

  insert into auth.users (id, email) values
    (v_admin_a, 'admin@ledger.test'),
    (v_mgr_a, 'mgr@ledger.test'),
    (v_rep_a, 'rep@ledger.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'admin@ledger.test', 'Ada', 'admin', v_admin_a, 'active') returning id into v_admin;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'mgr@ledger.test', 'Mo', 'manager', v_mgr_a, 'active') returning id into v_mgr;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@ledger.test', 'Raj', 'regular', v_rep_a, 'active') returning id into v_rep;

  insert into pipelines (organization_id, name, is_default)
  values (v_org, 'Quotes', false) returning id into v_pipeline;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability)
  values (v_org, v_pipeline, 'Quote', 0, 0.500) returning id into v_stage;
  insert into stages (organization_id, pipeline_id, name, "order", default_probability, outcome)
  values (v_org, v_pipeline, 'Won', 1, 1, 'won') returning id into v_won;

  insert into products (organization_id, name, unit_price)
  values (v_org, 'Speaker', 100) returning id into v_product;

  select id into v_toronto from stock_locations where organization_id = v_org;

  -- Owned by the rep, so the visibility rules have something to bite on.
  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Big order', v_stage, 500, 'USD', v_rep) returning id into v_deal;
  insert into deals (organization_id, name, stage_id, value, currency, owner_id)
  values (v_org, 'Second order', v_stage, 200, 'USD', v_rep) returning id into v_spare;

  insert into fixture values
    ('org', v_org),
    ('admin_auth', v_admin_a), ('mgr_auth', v_mgr_a), ('rep_auth', v_rep_a),
    ('admin', v_admin), ('mgr', v_mgr), ('rep', v_rep),
    ('pipeline', v_pipeline), ('stage', v_stage), ('won_stage', v_won),
    ('product', v_product), ('toronto', v_toronto),
    ('deal', v_deal), ('spare', v_spare);
end;
$$;

set local role authenticated;

-- =============================================================================
-- Deleting stamps rather than destroys.
-- =============================================================================
do $$
declare
  v_deal  uuid := (select id from fixture where key = 'deal');
  v_rep   uuid := (select id from fixture where key = 'rep');
  v_failed boolean := false;
begin
  raise notice 'Soft delete:';

  perform sign_in_as('rep_auth');
  perform public.soft_delete_deal(v_deal);

  perform test_assert(
    (select count(*) from deals where id = v_deal) = 0,
    'the deal leaves its own owner''s view'
  );

  perform sign_in_as('mgr_auth');
  perform test_assert(
    (select count(*) from deals where id = v_deal) = 0,
    'and a manager''s, who sees every live record'
  );

  perform sign_in_as('admin_auth');
  perform test_assert(
    (select count(*) from deals where id = v_deal) = 1,
    'an administrator can still see it — the bin has to be readable by somebody'
  );
  perform test_assert(
    (select deleted_by from deals where id = v_deal) = v_rep,
    'and knows who deleted it'
  );

  perform test_assert(
    (select count(*) from notifications
     where kind = 'deal_deleted' and user_id = (select id from fixture where key = 'admin')) = 1,
    'every administrator is told'
  );

  -- The one thing a soft delete must not do is lose the deal's contents.
  perform test_assert(
    (select name from deals where id = v_deal) = 'Big order',
    'nothing about the deal itself was destroyed'
  );

  perform sign_in_as('mgr_auth');
  begin
    perform public.restore_deal(v_deal);
  exception when others then
    v_failed := true;
  end;
  perform test_assert(v_failed, 'restoring is an administrator''s job — a manager cannot');

  perform sign_in_as('admin_auth');
  perform public.restore_deal(v_deal);

  perform sign_in_as('rep_auth');
  perform test_assert(
    (select count(*) from deals where id = v_deal) = 1,
    'and once restored it is back where it was'
  );
end;
$$;

-- =============================================================================
-- A deleted deal stops counting.
-- =============================================================================
do $$
declare
  v_deal     uuid := (select id from fixture where key = 'deal');
  v_product  uuid := (select id from fixture where key = 'product');
  v_toronto  uuid := (select id from fixture where key = 'toronto');
  v_stage    uuid := (select id from fixture where key = 'stage');
  v_summary  record;
begin
  raise notice 'What a deleted deal no longer holds:';

  perform sign_in_as('mgr_auth');
  perform public.set_stock_level(v_product, v_toronto, null, 100, null, 'Opening count');

  insert into deal_products (organization_id, deal_id, product_id, quantity, unit_price)
  values ((select id from fixture where key = 'org'), v_deal, v_product, 30, 100);

  select * into v_summary from public.product_stock_summary(v_product);
  perform test_assert(v_summary.committed = 30, 'an open deal commits its line items');

  perform test_assert(
    (select sum(deal_count) from public.report_pipeline_value(null, null)
     where stage_id = v_stage) = 2,
    'and both open deals are in the pipeline report'
  );

  perform sign_in_as('rep_auth');
  perform public.soft_delete_deal(v_deal);

  perform sign_in_as('mgr_auth');
  select * into v_summary from public.product_stock_summary(v_product);
  perform test_assert(
    v_summary.committed = 0,
    'deleting the deal releases the stock it had committed'
  );
  perform test_assert(v_summary.available = 100, 'so the whole shelf is available again');

  select * into v_summary
  from public.product_stock_overview() where product_id = v_product;
  perform test_assert(
    v_summary.committed = 0,
    'the catalogue-wide overview agrees with the single-product one'
  );

  perform test_assert(
    (select coalesce(sum(deal_count), 0) from public.report_pipeline_value(null, null)
     where stage_id = v_stage) = 1,
    'and the pipeline report has stopped counting it'
  );

  -- An administrator sees the deleted row, so the report has to exclude it
  -- explicitly rather than leaning on the policy that hides it from everyone
  -- else. This is the case that would have gone unnoticed.
  perform sign_in_as('admin_auth');
  perform test_assert(
    (select coalesce(sum(deal_count), 0) from public.report_pipeline_value(null, null)
     where stage_id = v_stage) = 1,
    'including for the administrator who can still see the deal'
  );

  perform test_assert(
    (select coalesce(sum(deal_count), 0) from public.report_product_mix(null, null)) = 0,
    'and the product mix leaves it out too'
  );

  perform public.restore_deal(v_deal);

  perform sign_in_as('mgr_auth');
  select * into v_summary from public.product_stock_summary(v_product);
  perform test_assert(v_summary.committed = 30, 'restoring puts the commitment back');
end;
$$;

-- =============================================================================
-- The side doors are closed too.
-- =============================================================================
do $$
declare
  v_deal   uuid := (select id from fixture where key = 'deal');
  v_mgr    uuid := (select id from fixture where key = 'mgr');
  v_priced boolean := false;
  v_moved  boolean := false;
begin
  raise notice 'A deleted deal is not editable around the back:';

  perform sign_in_as('rep_auth');
  perform public.soft_delete_deal(v_deal);

  perform sign_in_as('mgr_auth');

  begin
    perform public.set_deal_value_from_products(v_deal);
  exception when others then
    v_priced := true;
  end;
  perform test_assert(v_priced, 'a deal in the bin cannot be repriced from its line items');

  begin
    perform public.reassign_deal(v_deal, v_mgr);
  exception when others then
    v_moved := true;
  end;
  perform test_assert(v_moved, 'nor handed to a new owner');

  perform sign_in_as('admin_auth');
  perform public.restore_deal(v_deal);
end;
$$;

-- =============================================================================
-- Closing stamps who it belonged to.
-- =============================================================================
do $$
declare
  v_deal uuid := (select id from fixture where key = 'deal');
  v_rep  uuid := (select id from fixture where key = 'rep');
  v_mgr  uuid := (select id from fixture where key = 'mgr');
  v_won  uuid := (select id from fixture where key = 'won_stage');
  v_row  record;
begin
  raise notice 'Who owned it when it closed:';

  perform sign_in_as('mgr_auth');

  select * into v_row from deals where id = v_deal;
  perform test_assert(v_row.closed_owner_id is null, 'an open deal has closed nothing');

  update deals set stage_id = v_won where id = v_deal;

  select * into v_row from deals where id = v_deal;
  perform test_assert(v_row.status = 'won', 'dragging into the Won stage wins the deal');
  perform test_assert(
    v_row.closed_owner_id = v_rep,
    'and stamps the owner it was won by'
  );
  perform test_assert(v_row.closed_by = v_mgr, 'and separately who pressed the button');
  perform test_assert(v_row.closed_at is not null, 'and when');

  -- The whole reason the column exists.
  perform public.reassign_deal(v_deal, v_mgr);
  select * into v_row from deals where id = v_deal;
  perform test_assert(v_row.owner_id = v_mgr, 'the account can change hands afterwards');
  perform test_assert(
    v_row.closed_owner_id = v_rep,
    'without moving the win to its new owner'
  );

  -- An ordinary edit is not a re-close.
  update deals set value = 999 where id = v_deal;
  select * into v_row from deals where id = v_deal;
  perform test_assert(
    v_row.closed_owner_id = v_rep,
    'and editing a won deal does not re-stamp it either'
  );
end;
$$;

-- =============================================================================
-- Why it was lost, and what a reopening means.
-- =============================================================================
do $$
declare
  v_spare uuid := (select id from fixture where key = 'spare');
  v_stage uuid := (select id from fixture where key = 'stage');
  v_row   record;
begin
  raise notice 'Loss reasons:';

  perform sign_in_as('mgr_auth');

  perform test_assert(
    (select count(*) from field_options
     where organization_id = (select id from fixture where key = 'org')
       and entity_type = 'deal' and field_key = 'loss_reason') = 8,
    'an organization starts with a vocabulary for why a deal was lost'
  );

  update deals set status = 'lost', loss_reason = 'Price' where id = v_spare;

  select * into v_row from deals where id = v_spare;
  perform test_assert(v_row.loss_reason = 'Price', 'a lost deal can say why');
  perform test_assert(v_row.closed_owner_id is not null, 'losing is a close, and is stamped');
  perform test_assert(v_row.actual_close_date is not null, 'with a close date');

  -- Reopening has to undo all of it, or the deal claims a close that no longer
  -- happened and reporting counts a loss that is back in the pipeline.
  update deals set status = 'open' where id = v_spare;
  select * into v_row from deals where id = v_spare;
  perform test_assert(v_row.loss_reason is null, 'reopening clears the reason it was lost');
  perform test_assert(v_row.closed_owner_id is null, 'and the owner it was closed by');
  perform test_assert(v_row.closed_at is null, 'and the time it closed');
  perform test_assert(v_row.actual_close_date is null, 'and the close date, as it always did');

  -- A vocabulary the organization owns: adding a reason is a row, not a deploy.
  -- Written by an admin, because option lists are configuration.
  perform sign_in_as('admin_auth');
  insert into field_options (organization_id, entity_type, field_key, value, color, "order")
  values ((select id from fixture where key = 'org'), 'deal', 'loss_reason', 'Shipping cost', 'teal', 9);

  perform sign_in_as('mgr_auth');
  update deals set status = 'lost', loss_reason = 'Shipping cost', stage_id = v_stage
  where id = v_spare;
  perform test_assert(
    (select loss_reason from deals where id = v_spare) = 'Shipping cost',
    'and a reason an admin added is as good as a seeded one'
  );
end;
$$;

rollback;
