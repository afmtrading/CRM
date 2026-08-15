-- -----------------------------------------------------------------------------
-- Deleting a selection of contacts or companies
--
-- The single-record path already exists — soft_delete_contact and
-- soft_delete_company — and the obvious implementation of a bulk delete is to
-- call one of them in a loop. That is what this deliberately does not do, for
-- two reasons.
--
-- The first is noise. Each of those functions notifies every administrator, so
-- clearing 180 imported companies would put 180 notifications in front of each
-- of them and bury whatever else was there. One deletion is news; a hundred at
-- once is one piece of news with a number in it.
--
-- The second is atomicity. A loop that raises halfway through leaves the work
-- half done, and "half done" is the worst outcome for a destructive action:
-- there is no way to tell from the outside which half. A single statement is
-- all-or-nothing, and the count it returns is the truth about what happened.
--
-- Nothing is destroyed. This stamps deleted_at, exactly like the single-record
-- functions, so everything remains in Settings → Deleted records and remains
-- restorable one at a time.
-- -----------------------------------------------------------------------------

create or replace function public.bulk_delete_records(
  p_entity text,
  p_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org   uuid := public.current_org_id();
  v_actor uuid := public.current_app_user_id();
  v_count integer := 0;
  v_who   text;
begin
  if v_org is null then
    raise exception 'No organization in context';
  end if;

  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  /*
   * The same ceiling as bulk_update_records. It is not a performance limit —
   * the statement below would happily take ten thousand — but a bound on how
   * much one mis-click can do.
   */
  if array_length(p_ids, 1) > 500 then
    raise exception 'Too many records in one delete (limit 500)';
  end if;

  if not public.can_delete_records() then
    raise exception 'Your role does not allow deleting records';
  end if;

  /*
   * This runs as definer, so the row-level policies are not consulted and the
   * predicates below have to stand in for them. They are the select policy for
   * each table, written out:
   *
   *   already deleted    — excluded, so a repeated click reports 0 rather than
   *                        restamping the timestamp and losing when it happened
   *   can_see_owned      — a rep may not delete a colleague's contact merely by
   *                        knowing its id
   *   hidden             — without see_hidden the record is not visible, and
   *                        deleting what you cannot see is how a hidden record
   *                        gets discovered by its absence
   *
   * Companies have no owner, so they have no ownership clause — which matches
   * companies_select, where organization and visibility are the whole test.
   *
   * Ids that fail any of these are silently not deleted rather than raising.
   * The count comes back smaller than the selection and the caller says so;
   * naming which ones failed would tell somebody about records they are not
   * allowed to know exist.
   */
  if p_entity = 'contact' then
    with stamped as (
      update public.contacts
      set deleted_at = now(), deleted_by = v_actor
      where id = any(p_ids)
        and organization_id = v_org
        and deleted_at is null
        and public.can_see_owned(owner_id)
        and (hidden is false or public.can_see_hidden())
      returning 1
    )
    select count(*) into v_count from stamped;

  elsif p_entity = 'company' then
    with stamped as (
      update public.companies
      set deleted_at = now(), deleted_by = v_actor
      where id = any(p_ids)
        and organization_id = v_org
        and deleted_at is null
        and (hidden is false or public.can_see_hidden())
      returning 1
    )
    select count(*) into v_count from stamped;

  else
    raise exception 'Cannot bulk delete %', p_entity;
  end if;

  if v_count = 0 then
    return 0;
  end if;

  v_who := coalesce(
    (select name || ' (' || email || ')' from public.users where id = v_actor),
    'Someone'
  );

  perform public.notify_admins(
    v_org,
    case p_entity when 'contact' then 'contact_deleted' else 'company_deleted' end,
    v_count || ' ' ||
      case
        when p_entity = 'contact' and v_count = 1 then 'contact'
        when p_entity = 'contact' then 'contacts'
        when v_count = 1 then 'company'
        else 'companies'
      end || ' deleted',
    v_who || ' deleted ' || v_count || ' records in one action. They can still be restored.',
    '/settings/deleted'
  );

  return v_count;
end;
$fn$;

comment on function public.bulk_delete_records(text, uuid[]) is
  'Soft-deletes a selection of contacts or companies. Returns how many were actually stamped, which is at most the number asked for: records the caller cannot see are skipped without saying so.';

revoke execute on function public.bulk_delete_records(text, uuid[]) from public, anon;
grant execute on function public.bulk_delete_records(text, uuid[]) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The gap the new function closed, closed on the old ones too
--
-- soft_delete_contact tested can_see_owned but never hidden, so somebody
-- without see_hidden holding a hidden contact's id could delete it and learn it
-- existed by watching the count change. Same for soft_delete_company, which
-- tested neither. Both are recreated here with the visibility clause their bulk
-- equivalent has, so the two paths cannot disagree about who may delete what.
-- -----------------------------------------------------------------------------

create or replace function public.soft_delete_contact(p_contact_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_actor   uuid := public.current_app_user_id();
  v_visible boolean;
  v_name    text;
begin
  if not public.can_delete_records() then
    raise exception 'Your role does not allow deleting records';
  end if;

  select public.can_see_owned(owner_id) and (hidden is false or public.can_see_hidden()),
         trim(both ' ' from coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
  into v_visible, v_name
  from public.contacts
  where id = p_contact_id and organization_id = v_org and deleted_at is null;

  -- Same message whether the record is absent or merely out of sight. A
  -- distinct "you may not" would confirm that the id names something real.
  if v_visible is not true then
    raise exception 'Contact not found';
  end if;

  update public.contacts
  set deleted_at = now(), deleted_by = v_actor
  where id = p_contact_id and organization_id = v_org;

  perform public.notify_admins(
    v_org,
    'contact_deleted',
    'Contact deleted: ' || coalesce(nullif(v_name, ''), 'unnamed contact'),
    coalesce((select name || ' (' || email || ')' from public.users where id = v_actor), 'Someone')
      || ' deleted this contact. It can still be restored.',
    '/settings/deleted'
  );
end;
$$;

create or replace function public.soft_delete_company(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     uuid := public.current_org_id();
  v_actor   uuid := public.current_app_user_id();
  v_visible boolean;
  v_name    text;
begin
  if not public.can_delete_records() then
    raise exception 'Your role does not allow deleting records';
  end if;

  select hidden is false or public.can_see_hidden(), name
  into v_visible, v_name
  from public.companies
  where id = p_company_id and organization_id = v_org and deleted_at is null;

  if v_visible is not true then
    raise exception 'Company not found';
  end if;

  update public.companies
  set deleted_at = now(), deleted_by = v_actor
  where id = p_company_id and organization_id = v_org;

  perform public.notify_admins(
    v_org,
    'company_deleted',
    'Company deleted: ' || v_name,
    coalesce((select name || ' (' || email || ')' from public.users where id = v_actor), 'Someone')
      || ' deleted this company. It can still be restored.',
    '/settings/deleted'
  );
end;
$$;

revoke execute on function public.soft_delete_contact(uuid) from public, anon;
revoke execute on function public.soft_delete_company(uuid) from public, anon;
grant execute on function public.soft_delete_contact(uuid) to authenticated, service_role;
grant execute on function public.soft_delete_company(uuid) to authenticated, service_role;
