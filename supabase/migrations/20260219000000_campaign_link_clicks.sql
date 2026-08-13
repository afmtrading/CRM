-- =============================================================================
-- Which links people actually clicked
--
-- A single "Clicked: 12" is the least useful true thing a report can say. The
-- question anybody asks next is *which link*, and the answer is already in the
-- raw events — the provider names the URL in every click it reports. This is
-- what turns click tracking from a vanity number into something that changes
-- what goes in the next campaign.
--
-- email_events is deliberately unreadable by signed-in users: it carries no
-- organization_id, so there is no policy that could scope it safely, and a
-- table of raw provider payloads is nobody's business but the system's. This
-- function is the one door into it, and it opens exactly one campaign's worth —
-- for a caller who can already see that campaign.
-- =============================================================================
create or replace function public.campaign_link_clicks(p_campaign_id uuid)
returns table (url text, clicks integer, people integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign campaigns%rowtype;
begin
  select * into v_campaign from campaigns where id = p_campaign_id;
  if not found then
    raise exception 'Campaign not found';
  end if;

  -- Definer, so RLS is not doing the checking here and this has to. Reading a
  -- report is not a manager action — anybody who can see the campaign can see
  -- how it did — but it is emphatically an own-organization one.
  if public.current_org_id() is not null
     and v_campaign.organization_id <> public.current_org_id() then
    raise exception 'Campaign not found';
  end if;

  return query
  select
    e.payload -> 'data' -> 'click' ->> 'link' as url,
    count(*)::integer                         as clicks,
    count(distinct r.contact_id)::integer     as people
  from email_events e
  join campaign_recipients r on r.provider_id = e.provider_id
  where r.campaign_id = p_campaign_id
    and e.event_type = 'email.clicked'
    and e.payload -> 'data' -> 'click' ->> 'link' is not null
  group by 1
  -- By people rather than by raw clicks: one person opening the same link
  -- eleven times is not eleven times the interest.
  order by people desc, clicks desc, url;
end
$$;

revoke execute on function public.campaign_link_clicks(uuid) from public, anon;
grant execute on function public.campaign_link_clicks(uuid) to authenticated, service_role;

-- The join above is on provider_id; without this it is a sequential scan of
-- every event ever received, once per campaign page view.
create index if not exists email_events_clicked_idx
  on email_events (provider_id) where event_type = 'email.clicked';
