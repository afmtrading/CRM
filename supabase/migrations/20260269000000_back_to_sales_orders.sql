-- =============================================================================
-- `PO-` goes back to `SO-`
--
-- The section was renamed Purchase orders this afternoon and is Sales orders
-- again. The number prefix followed it out under 20260265000000 and follows it
-- back, for the reason that migration gave in the first place: half a book
-- reading `PO-` and half `SO-` is worse than either, because somebody looking
-- for an order would have to know which era it belongs to before knowing what
-- to search for.
--
-- These seven were `SO-` before this afternoon, so this is not a rename so
-- much as an undo — for anybody who saw them yesterday they are the numbers
-- they always were. The ids are written down in docs/DATA_CHANGES.md, read out
-- of production while they still said `PO-`.
-- =============================================================================

update public.sales_orders
set number = 'SO-' || substring(number from 4)
where number like 'PO-%';

-- -----------------------------------------------------------------------------
-- And the caller
--
-- `next_document_number` needs no change: 20260265000000 made its orders branch
-- accept either name precisely so a rename would not depend on every caller
-- moving in the same breath. That foresight is what makes this half a one-line
-- change rather than a second function rewrite.
--
-- Recreated from the live definition with one string changed — 'PO' back to
-- 'SO' — rather than rebuilt from what this file remembers of it, which is the
-- lesson 20260247000000 wrote down.
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
    public.next_document_number(v_org, 'SO', public.sales_order_slug(v_name)),
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
