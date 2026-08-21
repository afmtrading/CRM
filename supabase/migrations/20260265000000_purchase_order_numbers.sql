-- =============================================================================
-- SO- becomes PO-
--
-- The section is called Purchase orders, and the number on the document was
-- still the only place saying otherwise. Two halves: the numbers already
-- issued, and the ones allocated from now on.
--
-- THE ONE THAT IS NOT OBVIOUS
--
-- `next_document_number` takes the prefix as `p_kind` and *also* uses it to
-- decide which table to count:
--
--     select number from public.sales_orders where ... and p_kind = 'SO'
--     union all
--     select number from public.invoices     where ... and p_kind = 'INV'
--
-- Those are constant predicates, not row filters — with p_kind = 'PO' both
-- sides go false, the scan returns nothing, the maximum is zero, and every
-- order allocated would be PO-0001. Passing the new prefix without touching
-- this function would hand the same number to every order forever.
--
-- So the orders branch accepts either name. Old callers keep working, and the
-- rename does not depend on every one of them changing in the same breath.
-- =============================================================================

create or replace function public.next_document_number(
  p_org  uuid,
  p_kind text,          -- 'PO' (or its old name 'SO'), or 'INV'
  p_slug text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text;
  v_len    integer;
  v_max    integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_kind || ':' || p_org::text, 0));

  v_prefix := case
    when coalesce(nullif(p_slug, ''), '') = '' then p_kind || '-'
    else p_kind || '-' || p_slug || '-'
  end;
  v_len := length(v_prefix);

  /*
   * Matched by prefix and an all-digit remainder rather than by a pattern, so
   * the bare "PO-0001" sequence never picks up "PO-Acme-0001" — its remainder
   * is "Acme-0001", which is not a number — and neither counts the other's
   * rows. Each prefix therefore counts from one.
   */
  select coalesce(max(substring(number from v_len + 1)::integer), 0)
  into v_max
  from (
    select number from public.sales_orders
      where organization_id = p_org and p_kind in ('PO', 'SO')
    union all
    select number from public.invoices
      where organization_id = p_org and p_kind = 'INV'
  ) taken
  where left(number, v_len) = v_prefix
    and substring(number from v_len + 1) ~ '^[0-9]+$';

  return v_prefix || lpad((v_max + 1)::text, 4, '0');
end;
$$;

comment on function public.next_document_number(uuid, text, text) is
  'The next PO- or INV- number for an organization, allocated under a transaction-scoped advisory lock. Accepts the old ''SO'' as a name for the orders sequence.';

-- -----------------------------------------------------------------------------
-- The numbers already issued
--
-- Rewritten rather than left mixed. Half a book reading SO- and half PO- is
-- worse than either: somebody looking for "the PO" would have to know which
-- era a record belongs to before knowing what to search for.
--
-- Only the prefix moves — SO-0001 becomes PO-0001, and SO-Acme-0004 becomes
-- PO-Acme-0004 — so the sequence each organization has been counting is
-- unbroken and the numbers stay recognisable to anybody holding a copy.
--
-- Reversible by swapping the two strings below, which is written down in
-- docs/DATA_CHANGES.md along with what it touched.
-- -----------------------------------------------------------------------------

update public.sales_orders
set number = 'PO-' || substring(number from 4)
where number like 'SO-%';

-- -----------------------------------------------------------------------------
-- And the caller
--
-- Recreated from the live definition with one string changed — 'SO' to 'PO' —
-- rather than rebuilt from what this file remembers of it. That is the lesson
-- 20260247000000 wrote down: a function retyped from memory is a function that
-- quietly loses its security mode, its search_path, or a check nobody noticed
-- was in it.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_sales_order(p_company_id uuid DEFAULT NULL::uuid, p_contact_id uuid DEFAULT NULL::uuid, p_owner_id uuid DEFAULT NULL::uuid, p_currency text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org   uuid := public.current_org_id();
  v_actor uuid := public.current_app_user_id();
  v_name  text;
  v_id    uuid;
begin
  if not public.can_write_records() then
    raise exception 'Your role does not allow creating a sales order';
  end if;

  if p_company_id is not null then
    select name into v_name
    from public.companies
    where id = p_company_id and organization_id = v_org;

    if v_name is null then
      raise exception 'Company not found';
    end if;
  end if;

  insert into public.sales_orders (
    organization_id, number, company_id, contact_id, owner_id, currency,
    order_date, created_by, updated_by
  )
  values (
    v_org,
    public.next_document_number(v_org, 'PO', public.sales_order_slug(v_name)),
    p_company_id,
    p_contact_id,
    -- Unowned orders are invisible to a rep under can_see_owned, so the creator
    -- is the sensible default rather than nobody.
    coalesce(p_owner_id, v_actor),
    coalesce(nullif(p_currency, ''), public.org_currency(v_org)),
    -- Was the column default, current_date: the server's today rather than this
    -- organization's. Named explicitly so the two cannot drift apart again.
    public.org_today(v_org),
    v_actor,
    v_actor
  )
  returning id into v_id;

  return v_id;
end;
$function$;
