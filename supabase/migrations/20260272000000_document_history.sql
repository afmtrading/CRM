-- =============================================================================
-- What happened to a document, not just what it says now
--
-- The Record history card showed created_by and updated_by, which is everything
-- the row stores: two names and two timestamps. Edit an order five times and it
-- shows the fifth. Every change before the last is gone, and it was never
-- anywhere — the row has one updated_by and it gets overwritten.
--
-- This is the same asymmetry deal_stage_history was built on, and it is quoted
-- here because it decided the shape of this file: a report can be built at any
-- time from data already captured, but a change that happened yesterday and was
-- not recorded cannot be reconstructed. So the recording comes first.
--
-- WHAT IS AND IS NOT STORED
--
-- One row per field that actually changed: which document, which field, what it
-- was, what it became, who did it and when. A save that touches three fields
-- writes three rows, and a save that changes nothing writes none.
--
-- The *rendering* is not stored. `company_id` is kept as the uuid it is rather
-- than as the company's name at the time, because a name resolved at write time
-- is a second copy of it, free to drift from the first — the same reasoning the
-- stock ledger and this schema's other derived values follow. lib/document-
-- history turns ids into names when somebody looks.
-- =============================================================================

create table if not exists document_history (
  id              uuid primary key default gen_random_uuid(),
  /**
   * The order events actually happened in.
   *
   * changed_at alone is not enough, for the reason deal_stage_history gives:
   * two changes inside one transaction share a timestamp, and ordering by a
   * random uuid to break the tie puts a document's history in an arbitrary
   * sequence. One save writing three field rows is enough to do it.
   */
  seq             bigint generated always as identity,
  organization_id uuid not null references organizations (id) on delete cascade,
  /**
   * Which kind of document, and which one.
   *
   * A text discriminator and a bare uuid rather than two nullable foreign keys,
   * because the next document to want a history should need a trigger and not a
   * migration that widens this table. The cost is that the reference is not
   * enforced, which is why the select policy checks the parent exists.
   */
  entity          text not null,
  entity_id       uuid not null,
  action          text not null,
  /** Null on 'created': there is no one field a document was created in. */
  field           text,
  old_value       text,
  new_value       text,
  changed_by      uuid references users (id) on delete set null,
  -- clock_timestamp, not now(): an audit row wants the moment it was written,
  -- and now() would stamp every row in a transaction with the same instant.
  changed_at      timestamptz not null default clock_timestamp(),
  /**
   * How this row came to exist.
   *
   * 'trigger' is an observed fact, written at the moment it happened.
   * 'backfill' is not: it is one row per document that already existed when
   * this migration ran, asserting only "this existed by now", because the
   * changes it went through were never recorded and cannot be invented.
   * Anything reading this table has to be able to tell the two apart, so it is
   * a column rather than a comment.
   */
  source          text not null default 'trigger'
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_history_entity_check') then
    alter table document_history add constraint document_history_entity_check
      check (entity in ('sales_order', 'invoice'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'document_history_action_check') then
    alter table document_history add constraint document_history_action_check
      check (action in ('created', 'updated'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'document_history_source_check') then
    alter table document_history add constraint document_history_source_check
      check (source in ('trigger', 'backfill'));
  end if;

  -- A field row without a field says nothing. A created row with one is
  -- claiming a document was created in a single column.
  if not exists (select 1 from pg_constraint where conname = 'document_history_field_check') then
    alter table document_history add constraint document_history_field_check
      check ((action = 'updated') = (field is not null));
  end if;
end
$$;

-- The two questions asked of this table: one document's history, and what an
-- organization has been doing lately.
create index if not exists document_history_entity_idx
  on document_history (entity, entity_id, seq desc);
create index if not exists document_history_org_idx
  on document_history (organization_id, changed_at desc);

revoke all on document_history from anon;
-- Select only. Nobody writes history by hand: see the trigger below.
grant select on document_history to authenticated;

alter table document_history enable row level security;
alter table document_history force row level security;

/*
 * History follows the document it belongs to, stated through `exists` so it
 * cannot drift from the sales_orders and invoices policies — the same shape
 * deal_stage_history uses. Somebody who cannot see the order cannot see what
 * was done to it.
 */
drop policy if exists document_history_select on document_history;
create policy document_history_select on document_history
  for select to authenticated
  using (
    organization_id = public.current_org_id()
    and case entity
      when 'sales_order' then
        exists (select 1 from public.sales_orders o where o.id = document_history.entity_id)
      when 'invoice' then
        exists (select 1 from public.invoices i where i.id = document_history.entity_id)
      else false
    end
  );

-- No insert, update or delete policy, deliberately. A history somebody can edit
-- is not a history. The definer trigger below is the only writer — the same
-- "one door" the stock ledger and the payment ledgers are built on.

/**
 * Records every change to a document.
 *
 * Written as a diff of `to_jsonb(old)` against `to_jsonb(new)` rather than as a
 * list of column names, so a column added to sales_orders next month is
 * recorded without anybody remembering to come back here. The ignore list is
 * the bookkeeping — the columns that change on every save and say nothing about
 * what somebody did.
 *
 * AFTER rather than BEFORE: the document has to exist before a row can point at
 * it, which matters on INSERT.
 *
 * Definer because the table grants INSERT to nobody. That is the point — it
 * makes this the only writer, so the record cannot be edited around afterwards.
 */
create or replace function public.record_document_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity  text := tg_argv[0];
  v_actor   uuid := public.current_app_user_id();
  v_old     jsonb;
  v_new     jsonb;
  v_key     text;
  -- updated_at and updated_by change on every save and are the fact this table
  -- replaces. The rest never change at all.
  v_ignored constant text[] := array[
    'id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by'
  ];
begin
  /*
   * Both stamps are read out of the jsonb rather than off `new` directly.
   * `new.updated_by` is a compile-time reference in plpgsql and invoices has no
   * such column — the same trigger over two tables has to ask for what might
   * not be there, and `->>` answers null instead of failing.
   */
  v_new := to_jsonb(new);

  if tg_op = 'INSERT' then
    insert into public.document_history
      (organization_id, entity, entity_id, action, changed_by)
    values (
      new.organization_id, v_entity, new.id, 'created',
      coalesce(v_actor, (v_new ->> 'created_by')::uuid)
    );
    return null;
  end if;

  v_old := to_jsonb(old);

  for v_key in select jsonb_object_keys(v_new) loop
    continue when v_key = any (v_ignored);
    continue when v_old -> v_key is not distinct from v_new -> v_key;

    insert into public.document_history (
      organization_id, entity, entity_id, action, field, old_value, new_value, changed_by
    ) values (
      new.organization_id,
      v_entity,
      new.id,
      'updated',
      v_key,
      v_old ->> v_key,
      v_new ->> v_key,
      -- Falls back to the row's own stamp for a change made by a trigger rather
      -- than by a session — a payment landing moves an invoice's amount_paid.
      coalesce(v_actor, (v_new ->> 'updated_by')::uuid)
    );
  end loop;

  return null;
end;
$$;

comment on function public.record_document_history() is
  'Writes one document_history row per field that actually changed. The only writer of that table.';

drop trigger if exists sales_orders_history on public.sales_orders;
create trigger sales_orders_history
  after insert or update on public.sales_orders
  for each row execute function public.record_document_history('sales_order');

drop trigger if exists invoices_history on public.invoices;
create trigger invoices_history
  after insert or update on public.invoices
  for each row execute function public.record_document_history('invoice');

-- -----------------------------------------------------------------------------
-- What already exists
--
-- One row per document, marked as a backfill so nothing mistakes it for an
-- observed change. Stamped with the document's own created_at rather than now:
-- the assertion is "this existed by then", and dating it today would put every
-- old order at the top of a list sorted by when things happened.
-- -----------------------------------------------------------------------------

insert into public.document_history
  (organization_id, entity, entity_id, action, changed_by, changed_at, source)
select o.organization_id, 'sales_order', o.id, 'created', o.created_by, o.created_at, 'backfill'
from public.sales_orders o
where not exists (
  select 1 from public.document_history h
  where h.entity = 'sales_order' and h.entity_id = o.id
);

insert into public.document_history
  (organization_id, entity, entity_id, action, changed_by, changed_at, source)
select i.organization_id, 'invoice', i.id, 'created', i.created_by, i.created_at, 'backfill'
from public.invoices i
where not exists (
  select 1 from public.document_history h
  where h.entity = 'invoice' and h.entity_id = i.id
);
