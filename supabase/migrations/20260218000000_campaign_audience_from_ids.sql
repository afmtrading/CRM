-- =============================================================================
-- Building an audience from contacts the app has already chosen
--
-- build_campaign_audience() resolves a list by reading email_list_members. That
-- is right for a static list and wrong for a dynamic one, which is a saved
-- filter rather than a set of rows — it has no members to read, so it would
-- build an audience of nobody.
--
-- The filter engine lives in TypeScript (src/lib/filters.ts), where it is used
-- by every list screen and covered by its own tests. Teaching plpgsql to
-- evaluate the same JSON would mean a second implementation of it, and two
-- implementations of a rule like that do not stay the same — they drift, and
-- the day they disagree is the day a campaign goes to the wrong people.
--
-- So the division is: the app decides *who*, the database decides *whether*.
-- The app resolves a list to contact ids however that list works, and hands
-- them here; mailability is still judged row by row by contact_blocked_reason,
-- which remains the single answer to "may this person be emailed".
-- =============================================================================
create or replace function public.build_campaign_audience_for(
  p_campaign_id uuid,
  p_contact_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign campaigns%rowtype;
  v_count    integer;
begin
  select * into v_campaign from campaigns where id = p_campaign_id;
  if not found then
    raise exception 'Campaign not found';
  end if;

  -- Definer, so RLS is not doing the checking and this has to. Same guard as
  -- build_campaign_audience: own organization only, and only for somebody
  -- allowed to send. The drain has no session and is not restricted.
  if public.current_org_id() is not null then
    if v_campaign.organization_id <> public.current_org_id() then
      raise exception 'Campaign not found';
    end if;
    if not public.can_manage_records() then
      raise exception 'Sending a campaign is a manager action';
    end if;
  end if;

  -- Only while it is still a draft or scheduled. Adding recipients to a
  -- campaign that is already going out means somebody receives a message the
  -- person who approved it never saw being sent.
  if v_campaign.status not in ('draft', 'scheduled') then
    raise exception 'This campaign has already started sending';
  end if;

  if p_contact_ids is null or array_length(p_contact_ids, 1) is null then
    return 0;
  end if;

  insert into campaign_recipients
    (organization_id, campaign_id, contact_id, email, status, skip_reason)
  select
    c.organization_id,
    p_campaign_id,
    c.id,
    coalesce(c.email, ''),
    case when public.contact_blocked_reason(c.id) is null then 'pending' else 'skipped' end,
    public.contact_blocked_reason(c.id)
  from contacts c
  where c.id = any(p_contact_ids)
    -- The organization is re-checked against the campaign rather than trusted
    -- from the caller's ids: a definer function handed a list of uuids must
    -- assume they could be anybody's.
    and c.organization_id = v_campaign.organization_id
    and c.deleted_at is null
    and c.duplicate_of_id is null
  on conflict (campaign_id, contact_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function public.build_campaign_audience_for(uuid, uuid[]) from public, anon;
grant execute on function public.build_campaign_audience_for(uuid, uuid[])
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Clearing an audience that has not gone anywhere yet
--
-- Changing the list on a draft has to be able to take the old audience back
-- out, or the campaign quietly sends to both. Restricted to rows that have not
-- been sent, so this can never erase the record of a message that was actually
-- delivered.
-- -----------------------------------------------------------------------------
create or replace function public.clear_campaign_audience(p_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign campaigns%rowtype;
  v_count    integer;
begin
  select * into v_campaign from campaigns where id = p_campaign_id;
  if not found then
    raise exception 'Campaign not found';
  end if;

  if public.current_org_id() is not null then
    if v_campaign.organization_id <> public.current_org_id() then
      raise exception 'Campaign not found';
    end if;
    if not public.can_manage_records() then
      raise exception 'Sending a campaign is a manager action';
    end if;
  end if;

  if v_campaign.status not in ('draft', 'scheduled') then
    raise exception 'This campaign has already started sending';
  end if;

  delete from campaign_recipients
  where campaign_id = p_campaign_id
    and status in ('pending', 'skipped');

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function public.clear_campaign_audience(uuid) from public, anon;
grant execute on function public.clear_campaign_audience(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Keeping updated_at honest
-- -----------------------------------------------------------------------------
create or replace function public.campaigns_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists campaigns_touch on campaigns;
create trigger campaigns_touch
  before update on campaigns
  for each row execute function public.campaigns_touch();
