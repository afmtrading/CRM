-- =============================================================================
-- Campaigns, and the outbox that sends them
--
-- The shape of this whole feature is one decision: scheduling a campaign does
-- not send anything, it writes one row per recipient. A cron job then drains
-- those rows a batch at a time. Everything that matters falls out of that.
--
--   Resumable   a crashed run resumes where it stopped; the rows remember.
--   Idempotent  one row per contact per campaign, enforced by a unique index.
--               Nobody receives the same campaign twice, whatever happens to
--               the process that was sending it.
--   Auditable   afterwards you can answer "what exactly did this person get,
--               and when" from the database rather than from a log.
--   Bounded     a serverless function times out. A campaign of ten thousand
--               cannot be one request; small batches on a schedule can be any
--               size at all.
--
-- The claim uses FOR UPDATE SKIP LOCKED, which is what makes two overlapping
-- runs safe: the second skips whatever the first has already taken rather than
-- waiting for it or, far worse, sending it again.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- One definition of "may this person be emailed"
--
-- The view had this logic inline. The send loop needs the same answer, and two
-- copies of a rule like this diverge — so it moves into a function both call.
-- Definer because it reads the suppression list, and returns nothing but a
-- reason string.
-- -----------------------------------------------------------------------------
create or replace function public.contact_blocked_reason(p_contact_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    -- Definer, so it answers about any contact anywhere unless told not to.
    -- A session may only ask about its own organization; the drain has no
    -- session and asks about everyone's.
    when public.current_org_id() is not null
     and c.organization_id <> public.current_org_id()  then 'unknown'
    when c.email is null or btrim(c.email) = ''      then 'no_email'
    when c.marketing_consent = 'unsubscribed'        then 'unsubscribed'
    when exists (
      select 1 from email_suppressions s
      where s.organization_id = c.organization_id
        and lower(s.email) = lower(c.email)
    )                                                then 'suppressed'
    when c.mailable_override is false                then 'excluded'
    when c.mailable_override is true                 then null
    when c.marketing_consent = 'none'                then 'no_consent'
    when c.marketing_consent = 'implied'
     and (c.consent_at is null or c.consent_at < now() - interval '2 years')
                                                     then 'consent_expired'
    else null
  end
  from contacts c
  where c.id = p_contact_id;
$$;

-- `anon` named explicitly, and not only PUBLIC. Supabase's default privileges
-- grant EXECUTE to anon directly, so revoking from PUBLIC leaves that grant
-- standing — and the anon key ships in the browser bundle, so anything anon may
-- execute is reachable by anybody with the URL. Here it would answer "may this
-- contact be emailed" about any contact in any account, since an anonymous
-- caller has no organization for the guard inside to compare against.
revoke execute on function public.contact_blocked_reason(uuid) from public, anon;
grant execute on function public.contact_blocked_reason(uuid) to authenticated, service_role;

drop view if exists contact_mailability;

create view contact_mailability
with (security_invoker = true) as
select
  c.id            as contact_id,
  c.organization_id,
  c.email,
  c.marketing_consent,
  c.consent_at,
  c.mailable_override,
  public.contact_blocked_reason(c.id) as blocked_reason
from contacts c
where c.deleted_at is null
  and c.duplicate_of_id is null;

grant select on contact_mailability to authenticated;

-- -----------------------------------------------------------------------------
-- Campaigns
-- -----------------------------------------------------------------------------
create table if not exists campaigns (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,

  name            text not null,
  subject         text not null,
  /** Markdown, rendered by the same renderer the test send uses. */
  body            text not null,

  list_id         uuid references email_lists (id) on delete set null,

  /*
   * draft      being written; nothing exists downstream
   * scheduled  audience built, waiting for its time
   * sending    the drain is working through it
   * sent       every recipient reached a terminal state
   * paused     stopped by hand; pending rows stay pending
   * failed     something went wrong that a person needs to look at
   */
  status          text not null default 'draft'
                  check (status in ('draft', 'scheduled', 'sending', 'sent', 'paused', 'failed')),

  scheduled_at    timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,

  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists campaigns_org_idx on campaigns (organization_id);
-- The drain looks for work by status and time; this is the index it uses.
create index if not exists campaigns_due_idx on campaigns (status, scheduled_at);

-- -----------------------------------------------------------------------------
-- The outbox
-- -----------------------------------------------------------------------------
create table if not exists campaign_recipients (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  campaign_id     uuid not null references campaigns (id) on delete cascade,
  contact_id      uuid not null references contacts (id) on delete cascade,

  /*
   * The address as it was when the campaign was built. Kept rather than read
   * through the contact at send time, so a report a month later says where the
   * message actually went, not where that person's address happens to be now.
   */
  email           text not null,

  /*
   * pending    waiting to be sent
   * sending    claimed by a run, not yet handed to the provider
   * sent       the provider accepted it
   * delivered  the receiving server accepted it
   * opened     \ from webhooks; not every provider or recipient reports these
   * clicked    /
   * bounced    permanently undeliverable
   * complained marked as spam by the recipient
   * failed     the provider refused it
   * skipped    not sent on purpose — see skip_reason
   */
  status          text not null default 'pending'
                  check (status in ('pending', 'sending', 'sent', 'delivered', 'opened',
                                    'clicked', 'bounced', 'complained', 'failed', 'skipped')),

  /** Why it was withheld: the same vocabulary as contact_blocked_reason. */
  skip_reason     text,
  /** The provider's id for the message, which its webhooks refer back to. */
  provider_id     text,
  error           text,

  claimed_at      timestamptz,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  opened_at       timestamptz,
  clicked_at      timestamptz,
  created_at      timestamptz not null default now()
);

-- The guarantee that nobody gets a campaign twice, however many times the
-- audience is rebuilt or a run is retried.
create unique index if not exists campaign_recipients_once
  on campaign_recipients (campaign_id, contact_id);

-- What the claim query reads.
create index if not exists campaign_recipients_pending_idx
  on campaign_recipients (campaign_id, status) where status = 'pending';

-- What a webhook arrives holding.
create index if not exists campaign_recipients_provider_idx
  on campaign_recipients (provider_id) where provider_id is not null;

comment on table campaign_recipients is
  'The outbox. One row per contact per campaign, written when the campaign is scheduled and drained by cron. Its existence is what makes a send resumable and idempotent.';

-- -----------------------------------------------------------------------------
-- Raw events
--
-- Append-only, and kept even when they say nothing new. A provider's account of
-- what happened to a message is the only account there is, and reconstructing
-- it later from summary columns is not possible.
-- -----------------------------------------------------------------------------
create table if not exists email_events (
  id            uuid primary key default gen_random_uuid(),
  provider_id   text,
  event_type    text not null,
  recipient     text,
  payload       jsonb not null,
  received_at   timestamptz not null default now()
);

create index if not exists email_events_provider_idx on email_events (provider_id);

-- -----------------------------------------------------------------------------
-- Building the audience
--
-- Called when a campaign is scheduled. Resolves the list to contacts, checks
-- each one against the mailability rules, and writes a row for every one —
-- including the ones being withheld, marked skipped with the reason.
--
-- Withheld recipients are written rather than filtered out on purpose: "we did
-- not send to these forty people, and here is why" is a question worth being
-- able to answer, and a row is the only thing that can answer it.
-- -----------------------------------------------------------------------------
create or replace function public.build_campaign_audience(p_campaign_id uuid)
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

  /*
   * Definer, so RLS is not doing the checking here and this has to. A caller
   * with a session may only build an audience for a campaign in their own
   * organization, and only if they are allowed to send at all. The drain runs
   * without a session — current_org_id() is null — and is not restricted.
   */
  if public.current_org_id() is not null then
    if v_campaign.organization_id <> public.current_org_id() then
      raise exception 'Campaign not found';
    end if;
    if not public.can_manage_records() then
      raise exception 'Sending a campaign is a manager action';
    end if;
  end if;

  if v_campaign.list_id is null then
    raise exception 'A campaign needs a list before it has an audience';
  end if;

  /*
   * Only contacts not already on the campaign are inserted, so building twice
   * adds anybody the list has gained without disturbing what is already there
   * — and cannot re-queue somebody who has already been sent to.
   */
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
  join email_list_members m on m.contact_id = c.id
  where m.list_id = v_campaign.list_id
    and c.organization_id = v_campaign.organization_id
    and c.deleted_at is null
    and c.duplicate_of_id is null
  on conflict (campaign_id, contact_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- -----------------------------------------------------------------------------
-- Claiming a batch
--
-- The heart of it. SKIP LOCKED is what allows two runs to overlap safely: the
-- second passes over rows the first has locked instead of blocking on them, so
-- neither waits and neither sends the same message twice.
--
-- Mailability is checked again here, at the moment of sending, rather than
-- trusted from when the audience was built. Somebody may have unsubscribed in
-- between — and mailing them anyway is precisely the failure the law cares
-- about, not a rounding error.
-- -----------------------------------------------------------------------------
create or replace function public.claim_campaign_batch(p_limit integer default 50)
returns table (
  recipient_id   uuid,
  campaign_id    uuid,
  contact_id     uuid,
  email          text,
  first_name     text,
  last_name      text,
  company_name   text,
  unsubscribe_token uuid,
  subject        text,
  body           text,
  organization_id uuid,
  organization_name text,
  logo_url       text,
  from_name      text,
  from_address   text,
  reply_to       text,
  postal_address text,
  blocked_reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select r.id
    from campaign_recipients r
    join campaigns c on c.id = r.campaign_id
    where r.status = 'pending'
      and c.status = 'sending'
    order by r.created_at
    limit greatest(coalesce(p_limit, 50), 1)
    for update of r skip locked
  ),
  claimed as (
    update campaign_recipients r
    set status = 'sending', claimed_at = now()
    from picked
    where r.id = picked.id
    returning r.*
  )
  select
    cl.id,
    cl.campaign_id,
    cl.contact_id,
    cl.email,
    ct.first_name,
    ct.last_name,
    co.name,
    ct.unsubscribe_token,
    ca.subject,
    ca.body,
    ca.organization_id,
    org.name,
    org.logo_url,
    sd.from_name,
    sd.from_local || '@' || sd.domain,
    sd.reply_to,
    sd.postal_address,
    public.contact_blocked_reason(cl.contact_id)
  from claimed cl
  join campaigns ca      on ca.id = cl.campaign_id
  join contacts ct       on ct.id = cl.contact_id
  join organizations org on org.id = cl.organization_id
  left join companies co on co.id = ct.company_id
  left join sending_domains sd on sd.organization_id = cl.organization_id;
end
$$;

/** Marks what happened to one claimed recipient. */
create or replace function public.finish_campaign_recipient(
  p_recipient_id uuid,
  p_status text,
  p_provider_id text default null,
  p_error text default null,
  p_skip_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update campaign_recipients
  set status      = p_status,
      provider_id = coalesce(p_provider_id, provider_id),
      error       = p_error,
      skip_reason = p_skip_reason,
      sent_at     = case when p_status = 'sent' then now() else sent_at end
  where id = p_recipient_id;
end
$$;

/**
 * Closes a campaign once nothing is left waiting.
 *
 * Called after each batch rather than counted up front: a campaign is finished
 * when its outbox is empty, which is a question the outbox answers.
 */
create or replace function public.settle_campaigns()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update campaigns c
  set status = 'sent', finished_at = now()
  where c.status = 'sending'
    and not exists (
      select 1 from campaign_recipients r
      where r.campaign_id = c.id and r.status in ('pending', 'sending')
    );

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

/** Moves scheduled campaigns whose time has come into sending. */
create or replace function public.start_due_campaigns()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update campaigns
  set status = 'sending', started_at = coalesce(started_at, now())
  where status = 'scheduled'
    and (scheduled_at is null or scheduled_at <= now());

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- -----------------------------------------------------------------------------
-- What a provider tells us afterwards
--
-- Records the event, moves the recipient along, and — for a bounce or a
-- complaint — writes a suppression. That last part is the one that matters:
-- an address that hard-bounced or whose owner marked the message as spam must
-- never be sent to again, and leaving that to a person to notice would mean it
-- never happens.
-- -----------------------------------------------------------------------------
create or replace function public.record_email_event(
  p_provider_id text,
  p_event_type text,
  p_recipient text,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recipient campaign_recipients%rowtype;
begin
  insert into email_events (provider_id, event_type, recipient, payload)
  values (p_provider_id, p_event_type, p_recipient, coalesce(p_payload, '{}'::jsonb));

  select * into v_recipient
  from campaign_recipients
  where provider_id = p_provider_id
  limit 1;

  if not found then
    -- A test send has no outbox row. The event is still worth keeping.
    return;
  end if;

  update campaign_recipients
  set status = case p_event_type
        when 'email.delivered'       then 'delivered'
        when 'email.opened'          then 'opened'
        when 'email.clicked'         then 'clicked'
        when 'email.bounced'         then 'bounced'
        when 'email.complained'      then 'complained'
        when 'email.delivery_delayed' then status
        else status
      end,
      delivered_at = case when p_event_type = 'email.delivered' then now() else delivered_at end,
      opened_at    = case when p_event_type = 'email.opened'  then coalesce(opened_at, now()) else opened_at end,
      clicked_at   = case when p_event_type = 'email.clicked' then coalesce(clicked_at, now()) else clicked_at end
  where id = v_recipient.id;

  if p_event_type in ('email.bounced', 'email.complained') then
    insert into email_suppressions (organization_id, email, reason, contact_id, note)
    values (
      v_recipient.organization_id,
      lower(v_recipient.email),
      case when p_event_type = 'email.bounced' then 'bounced' else 'complained' end,
      v_recipient.contact_id,
      'Reported by the email provider'
    )
    on conflict (organization_id, lower(email)) do nothing;
  end if;
end
$$;

-- The drain and the webhook run as the service role from a cron job and a
-- provider callback. Neither is a signed-in user, and neither should be
-- reachable by one.
-- `anon` is named alongside PUBLIC deliberately. Supabase's default privileges
-- grant EXECUTE to anon *directly*, so revoking from PUBLIC does not remove it
-- — and the anon key is published in the browser bundle. Left as it was, a
-- stranger could POST to /rest/v1/rpc/record_email_event and forge a bounce,
-- suppressing any address they chose: around the webhook's signature check
-- rather than through it.
revoke execute on function public.claim_campaign_batch(integer) from public, anon, authenticated;
revoke execute on function public.finish_campaign_recipient(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.settle_campaigns() from public, anon, authenticated;
revoke execute on function public.start_due_campaigns() from public, anon, authenticated;
revoke execute on function public.record_email_event(text, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.claim_campaign_batch(integer) to service_role;
grant execute on function public.finish_campaign_recipient(uuid, text, text, text, text) to service_role;
grant execute on function public.settle_campaigns() to service_role;
grant execute on function public.start_due_campaigns() to service_role;
grant execute on function public.record_email_event(text, text, text, jsonb) to service_role;

revoke execute on function public.build_campaign_audience(uuid) from public, anon;
grant execute on function public.build_campaign_audience(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table campaigns           enable row level security;
alter table campaign_recipients enable row level security;
alter table email_events        enable row level security;

alter table campaigns           force row level security;
alter table campaign_recipients force row level security;
alter table email_events        force row level security;

create policy campaigns_select on campaigns
  for select to authenticated
  using (organization_id = public.current_org_id());

-- Sending is the one action in the CRM that reaches outside the company, so it
-- sits with managers and administrators rather than with everyone who can edit.
create policy campaigns_insert on campaigns
  for insert to authenticated
  with check (organization_id = public.current_org_id() and public.can_manage_records());

create policy campaigns_update on campaigns
  for update to authenticated
  using (organization_id = public.current_org_id() and public.can_manage_records())
  with check (organization_id = public.current_org_id());

create policy campaigns_delete on campaigns
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.can_manage_records());

create policy campaign_recipients_select on campaign_recipients
  for select to authenticated
  using (organization_id = public.current_org_id());

-- Deliberately no insert, update or delete for signed-in users: the outbox is
-- written by build_campaign_audience and moved along by the drain. A row edited
-- by hand is a message sent twice or not at all.

-- email_events carries no organization_id and is nobody's business but the
-- system's; there is no policy, so authenticated sees nothing.

grant select, insert, update, delete on campaigns to authenticated;
grant select on campaign_recipients to authenticated;
