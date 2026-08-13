-- =============================================================================
-- Campaigns and the outbox.
--
-- One property matters more than all the others: **nobody receives the same
-- campaign twice**. Everything here is either that property, or one of the
-- things that would quietly break it.
--
--   * building the audience twice must not queue anybody twice
--   * two overlapping runs must not both claim the same row — this is what
--     SKIP LOCKED is for, and it is the one that only fails under load, in
--     production, in front of the recipients
--   * somebody who unsubscribes after the campaign is queued must not be sent
--     to anyway. The audience was built hours ago; consent is now.
--   * a bounce must suppress the address, or a dead address is mailed forever
--   * the outbox must not be editable by hand, or none of the above holds
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

/** The outbox row for one contact on one campaign, read past RLS. */
create or replace function recipient_status(p_campaign uuid, p_contact uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select status from campaign_recipients
  where campaign_id = p_campaign and contact_id = p_contact;
$$;

create or replace function recipient_skip(p_campaign uuid, p_contact uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select skip_reason from campaign_recipients
  where campaign_id = p_campaign and contact_id = p_contact;
$$;

create or replace function recipient_count(p_campaign uuid)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from campaign_recipients where campaign_id = p_campaign;
$$;

create or replace function campaign_status(p_campaign uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select status from campaigns where id = p_campaign;
$$;

grant execute on function recipient_status(uuid, uuid) to authenticated;
grant execute on function recipient_skip(uuid, uuid) to authenticated;
grant execute on function recipient_count(uuid) to authenticated;
grant execute on function campaign_status(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Two organizations, a manager and a rep, a list with four kinds of contact.
-- -----------------------------------------------------------------------------
do $$
declare
  v_org      uuid;
  v_other    uuid;
  v_mgr_a    uuid := gen_random_uuid();
  v_rep_a    uuid := gen_random_uuid();
  v_mgr      uuid;
  v_rep      uuid;
  v_list     uuid;
  v_good     uuid;
  v_also     uuid;
  v_nope     uuid;
  v_gone     uuid;
  v_theirs_c uuid;
  v_theirs_l uuid;
  v_theirs_k uuid;
begin
  insert into organizations (name, slug) values ('Blast Co', 'blast-co') returning id into v_org;
  insert into organizations (name, slug) values ('Rival Co', 'rival-co') returning id into v_other;

  insert into auth.users (id, email) values
    (v_mgr_a, 'mgr@blast.test'),
    (v_rep_a, 'rep@blast.test');

  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'mgr@blast.test', 'Mo', 'manager', v_mgr_a, 'active') returning id into v_mgr;
  insert into users (organization_id, email, name, role, auth_provider_id, status)
  values (v_org, 'rep@blast.test', 'Rae', 'regular', v_rep_a, 'active') returning id into v_rep;

  insert into sending_domains (organization_id, domain, from_name, from_local, postal_address)
  values (v_org, 'news.blast.test', 'Blast Co', 'hello', '1 Test Street');

  insert into email_lists (organization_id, name) values (v_org, 'Everyone')
  returning id into v_list;

  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Good', 'good@example.com', v_mgr, 'express', now()) returning id into v_good;

  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, consent_at)
  values (v_org, 'Also', 'also@example.com', v_mgr, 'express', now()) returning id into v_also;

  -- No consent recorded, so this one is queued as skipped rather than pending.
  insert into contacts (organization_id, first_name, email, owner_id)
  values (v_org, 'Nope', 'nope@example.com', v_mgr) returning id into v_nope;

  -- Already unsubscribed before the campaign is built at all.
  insert into contacts (organization_id, first_name, email, owner_id, marketing_consent, unsubscribed_at)
  values (v_org, 'Gone', 'gone@example.com', v_mgr, 'unsubscribed', now()) returning id into v_gone;

  insert into email_list_members (organization_id, list_id, contact_id) values
    (v_org, v_list, v_good),
    (v_org, v_list, v_also),
    (v_org, v_list, v_nope),
    (v_org, v_list, v_gone);

  -- The rival's own campaign, made here while superuser because RLS would
  -- rightly refuse it later — which is the property being tested.
  insert into contacts (organization_id, first_name, email, marketing_consent, consent_at)
  values (v_other, 'Theirs', 'theirs@example.com', 'express', now()) returning id into v_theirs_c;

  insert into email_lists (organization_id, name) values (v_other, 'Their list')
  returning id into v_theirs_l;
  insert into email_list_members (organization_id, list_id, contact_id)
  values (v_other, v_theirs_l, v_theirs_c);

  insert into campaigns (organization_id, name, subject, body, list_id, status)
  values (v_other, 'Their campaign', 'Hi', 'Body', v_theirs_l, 'draft')
  returning id into v_theirs_k;

  insert into fixture values
    ('org', v_org), ('other', v_other),
    ('mgr_auth', v_mgr_a), ('rep_auth', v_rep_a),
    ('mgr', v_mgr), ('rep', v_rep),
    ('list', v_list),
    ('good', v_good), ('also', v_also), ('nope', v_nope), ('gone', v_gone),
    ('theirs_contact', v_theirs_c), ('theirs_campaign', v_theirs_k);
end;
$$;

-- =============================================================================
-- Building the audience.
-- =============================================================================
do $$
declare
  v_org  uuid := (select id from fixture where key = 'org');
  v_list uuid := (select id from fixture where key = 'list');
  v_id   uuid;
  v_n    integer;
begin
  raise notice 'Building the audience:';

  insert into campaigns (organization_id, name, subject, body, list_id, created_by)
  values (v_org, 'Spring', 'Hello {{first_name}}', 'A message.', v_list,
          (select id from fixture where key = 'mgr'))
  returning id into v_id;
  insert into fixture values ('campaign', v_id);

  v_n := build_campaign_audience(v_id);
  perform test_assert(v_n = 4, 'every member of the list gets a row, including the ones being withheld');

  perform test_assert(
    recipient_status(v_id, (select id from fixture where key = 'good')) = 'pending',
    'a contact with express consent is queued to send'
  );

  -- The withheld ones are written, not filtered out: "we did not mail these
  -- people, and here is why" is a question worth being able to answer.
  perform test_assert(
    recipient_status(v_id, (select id from fixture where key = 'nope')) = 'skipped'
    and recipient_skip(v_id, (select id from fixture where key = 'nope')) = 'no_consent',
    'a contact with no consent is recorded as skipped, with the reason'
  );

  perform test_assert(
    recipient_skip(v_id, (select id from fixture where key = 'gone')) = 'unsubscribed',
    'somebody who unsubscribed is skipped and says so'
  );

  v_n := build_campaign_audience(v_id);
  perform test_assert(v_n = 0, 'building the audience again queues nobody a second time');
  perform test_assert(recipient_count(v_id) = 4, 'and adds no rows');
end;
$$;

-- =============================================================================
-- A list that grows after the audience was built.
-- =============================================================================
do $$
declare
  v_org uuid := (select id from fixture where key = 'org');
  v_list uuid := (select id from fixture where key = 'list');
  v_id  uuid := (select id from fixture where key = 'campaign');
  v_new uuid;
begin
  raise notice 'A growing list:';

  insert into contacts (organization_id, first_name, email, marketing_consent, consent_at)
  values (v_org, 'Late', 'late@example.com', 'express', now()) returning id into v_new;
  insert into email_list_members (organization_id, list_id, contact_id)
  values (v_org, v_list, v_new);

  perform test_assert(
    build_campaign_audience(v_id) = 1,
    'rebuilding picks up somebody the list has gained since'
  );
  perform test_assert(recipient_status(v_id, v_new) = 'pending', 'and queues them');
end;
$$;

-- =============================================================================
-- Claiming, and the guarantee that nothing is sent twice.
-- =============================================================================
do $$
declare
  v_id    uuid := (select id from fixture where key = 'campaign');
  v_first integer;
  v_again integer;
begin
  raise notice 'Claiming a batch:';

  perform test_assert(
    (select count(*) from claim_campaign_batch(50)) = 0,
    'a campaign that is not sending yields nothing to send'
  );

  update campaigns set status = 'scheduled', scheduled_at = now() + interval '1 day'
  where id = v_id;
  perform test_assert(start_due_campaigns() = 0, 'a campaign scheduled for tomorrow does not start today');

  update campaigns set scheduled_at = now() - interval '1 minute' where id = v_id;
  perform test_assert(start_due_campaigns() = 1, 'a campaign whose time has come starts');
  perform test_assert(campaign_status(v_id) = 'sending', 'and is now sending');

  select count(*) into v_first from claim_campaign_batch(50);
  perform test_assert(v_first = 3, 'the claim takes the pending rows and leaves the skipped ones');

  /*
   * A second run must find nothing left to take, or somebody is sent the same
   * message twice. Note what this does and does not prove: one connection
   * cannot demonstrate SKIP LOCKED, which only does its work between concurrent
   * transactions. What is tested here is the other half of the same guarantee —
   * that claiming moves a row out of 'pending' — and that half is what makes
   * the lock's job finite.
   */
  select count(*) into v_again from claim_campaign_batch(50);
  perform test_assert(v_again = 0, 'a second run finds nothing left to claim');

  perform test_assert(
    recipient_status(v_id, (select id from fixture where key = 'good')) = 'sending',
    'a claimed row is marked as being worked on'
  );
end;
$$;

-- =============================================================================
-- Consent is re-read at the moment of sending, not trusted from build time.
-- =============================================================================
do $$
declare
  v_org  uuid := (select id from fixture where key = 'org');
  v_list uuid := (select id from fixture where key = 'list');
  v_id   uuid;
  v_who  uuid;
  v_row  record;
begin
  raise notice 'Consent at send time:';

  insert into contacts (organization_id, first_name, email, marketing_consent, consent_at)
  values (v_org, 'Changed', 'changed@example.com', 'express', now()) returning id into v_who;
  insert into email_list_members (organization_id, list_id, contact_id) values (v_org, v_list, v_who);

  insert into campaigns (organization_id, name, subject, body, list_id, status)
  values (v_org, 'Later', 'Hi', 'Body', v_list, 'draft') returning id into v_id;

  perform build_campaign_audience(v_id);
  perform test_assert(recipient_status(v_id, v_who) = 'pending', 'queued while they still consented');

  -- Hours pass. They unsubscribe. Mailing them anyway is precisely the failure
  -- the law cares about, not a rounding error.
  update contacts set marketing_consent = 'unsubscribed', unsubscribed_at = now() where id = v_who;

  update campaigns set status = 'sending' where id = v_id;

  select * into v_row from claim_campaign_batch(50) where contact_id = v_who;
  perform test_assert(
    v_row.blocked_reason = 'unsubscribed',
    'the claim reports that they may no longer be mailed'
  );

  -- And the same for an address suppressed since the audience was built.
  perform finish_campaign_recipient(v_row.recipient_id, 'skipped', null, null, v_row.blocked_reason);
  perform test_assert(recipient_status(v_id, v_who) = 'skipped', 'so the send withholds it');
  perform test_assert(recipient_skip(v_id, v_who) = 'unsubscribed', 'and records why');

  insert into fixture values ('later', v_id);
end;
$$;

-- =============================================================================
-- Settling, and what a provider says afterwards.
-- =============================================================================
do $$
declare
  v_id   uuid := (select id from fixture where key = 'campaign');
  v_good uuid := (select id from fixture where key = 'good');
  v_also uuid := (select id from fixture where key = 'also');
  v_r    uuid;
begin
  raise notice 'Finishing:';

  perform test_assert(settle_campaigns() = 0, 'a campaign with rows still in flight is not finished');

  update campaign_recipients set status = 'sent', provider_id = 'prov_' || id::text
  where campaign_id = v_id and status = 'sending';

  perform test_assert(settle_campaigns() = 1, 'a campaign with an empty outbox is finished');
  perform test_assert(campaign_status(v_id) = 'sent', 'and is marked sent');
  perform test_assert(settle_campaigns() = 0, 'settling twice changes nothing');

  select id into v_r from campaign_recipients where campaign_id = v_id and contact_id = v_good;

  perform record_email_event('prov_' || v_r::text, 'email.delivered', 'good@example.com', '{}'::jsonb);
  perform test_assert(recipient_status(v_id, v_good) = 'delivered', 'a delivery event moves the row along');

  perform record_email_event('prov_' || v_r::text, 'email.opened', 'good@example.com', '{}'::jsonb);
  perform test_assert(recipient_status(v_id, v_good) = 'opened', 'and so does an open');
end;
$$;

-- =============================================================================
-- A bounce suppresses the address. This is the one that costs real money.
-- =============================================================================
do $$
declare
  v_org  uuid := (select id from fixture where key = 'org');
  v_id   uuid := (select id from fixture where key = 'campaign');
  v_also uuid := (select id from fixture where key = 'also');
  v_r    uuid;
begin
  raise notice 'Bounces and complaints:';

  select id into v_r from campaign_recipients where campaign_id = v_id and contact_id = v_also;

  perform record_email_event('prov_' || v_r::text, 'email.bounced', 'also@example.com',
                             '{"type":"email.bounced"}'::jsonb);

  perform test_assert(recipient_status(v_id, v_also) = 'bounced', 'the row records the bounce');

  -- Without this, a dead address is mailed on every campaign forever, and the
  -- sending domain's reputation goes with it.
  perform test_assert(
    exists (select 1 from email_suppressions
            where organization_id = v_org and lower(email) = 'also@example.com'),
    'a bounce suppresses the address for good'
  );

  perform test_assert(
    (select blocked_reason from contact_mailability where contact_id = v_also) = 'suppressed',
    'so that contact is no longer mailable at all'
  );

  -- Arriving twice is normal — providers retry — and must not raise.
  perform record_email_event('prov_' || v_r::text, 'email.bounced', 'also@example.com', '{}'::jsonb);
  perform test_assert(
    (select count(*) from email_suppressions
     where organization_id = v_org and lower(email) = 'also@example.com') = 1,
    'the same bounce arriving twice suppresses once'
  );

  perform test_assert(
    (select count(*) from email_events where event_type = 'email.bounced') = 2,
    'but both events are kept — the provider’s account is the only account there is'
  );
end;
$$;

-- =============================================================================
-- An event about a message with no outbox row.
-- =============================================================================
do $$
begin
  raise notice 'Unknown messages:';

  -- A test send has no outbox row. The event is still worth keeping, and must
  -- not raise: a webhook that errors is a webhook the provider keeps retrying.
  perform record_email_event('prov_never_seen', 'email.delivered', 'someone@example.com', '{}'::jsonb);
  perform test_assert(
    exists (select 1 from email_events where provider_id = 'prov_never_seen'),
    'an event about a message we have no row for is still recorded'
  );
end;
$$;

-- =============================================================================
-- Who may do any of this.
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_list   uuid := (select id from fixture where key = 'list');
  v_id     uuid := (select id from fixture where key = 'campaign');
  v_theirs uuid := (select id from fixture where key = 'theirs_campaign');
  v_new    uuid;
  v_n      integer;
begin
  raise notice 'Permissions:';

  set local role authenticated;
  perform sign_in_as('mgr_auth');

  insert into campaigns (organization_id, name, subject, body, list_id)
  values (v_org, 'By a manager', 'Hi', 'Body', v_list) returning id into v_new;
  perform test_assert(v_new is not null, 'a manager may create a campaign');

  perform test_assert(
    (select count(*) from campaigns where id = v_id) = 1,
    'and can read their own organization’s campaigns'
  );

  -- Sending is the one action in the CRM that reaches outside the company.
  perform test_assert(
    (select count(*) from campaigns where id = v_theirs) = 0,
    'another organization’s campaign is invisible'
  );

  begin
    perform build_campaign_audience(v_theirs);
    raise exception 'TEST FAILED: built another organization’s audience';
  exception
    when others then
      if position('TEST FAILED' in sqlerrm) > 0 then raise; end if;
      raise notice '  ok: building another organization’s audience is refused';
  end;

  perform test_assert(
    (select count(*) from campaign_recipients where campaign_id = v_id) > 0,
    'a manager can see who a campaign went to'
  );

  -- No insert, update or delete policy exists on the outbox: a row edited by
  -- hand is a message sent twice or not at all.
  begin
    update campaign_recipients set status = 'pending' where campaign_id = v_id;
    if found then
      raise exception 'TEST FAILED: edited the outbox by hand';
    end if;
    raise notice '  ok: the outbox cannot be edited by hand';
  exception
    when insufficient_privilege then
      raise notice '  ok: the outbox cannot be edited by hand';
  end;

  -- The drain's functions are the service role's alone; a session must not be
  -- able to send anything by calling them directly.
  -- Specifically insufficient_privilege, not "any error at all": a catch-all
  -- here would go green on a typo in the function name and prove nothing.
  begin
    perform claim_campaign_batch(10);
    raise exception 'TEST FAILED: a signed-in user claimed a batch';
  exception
    when insufficient_privilege then
      raise notice '  ok: a signed-in user cannot claim a batch';
  end;

  begin
    perform record_email_event('prov_x', 'email.bounced', 'someone@example.com', '{}'::jsonb);
    raise exception 'TEST FAILED: a signed-in user recorded a provider event';
  exception
    when insufficient_privilege then
      raise notice '  ok: a signed-in user cannot forge a provider event';
  end;

  begin
    perform settle_campaigns();
    raise exception 'TEST FAILED: a signed-in user settled campaigns';
  exception
    when insufficient_privilege then
      raise notice '  ok: a signed-in user cannot run the drain’s bookkeeping';
  end;

  reset role;
end;
$$;

-- =============================================================================
-- A rep is not a sender.
-- =============================================================================
do $$
declare
  v_org  uuid := (select id from fixture where key = 'org');
  v_list uuid := (select id from fixture where key = 'list');
  v_id   uuid := (select id from fixture where key = 'campaign');
begin
  raise notice 'A rep:';

  set local role authenticated;
  perform sign_in_as('rep_auth');

  begin
    insert into campaigns (organization_id, name, subject, body, list_id)
    values (v_org, 'By a rep', 'Hi', 'Body', v_list);
    raise exception 'TEST FAILED: a rep created a campaign';
  exception
    when insufficient_privilege then
      raise notice '  ok: a rep cannot create a campaign';
    when others then
      if position('TEST FAILED' in sqlerrm) > 0 then raise; end if;
      raise notice '  ok: a rep cannot create a campaign';
  end;

  -- Reading is fine: knowing what the company sent is not the same as sending.
  perform test_assert(
    (select count(*) from campaigns where id = v_id) = 1,
    'but can see what the company has sent'
  );

  reset role;
end;
$$;

-- =============================================================================
-- Cross-tenant reach.
-- =============================================================================
do $$
declare
  v_theirs uuid := (select id from fixture where key = 'theirs_contact');
begin
  raise notice 'Cross-tenant:';

  set local role authenticated;
  perform sign_in_as('mgr_auth');

  perform test_assert(
    contact_blocked_reason(v_theirs) = 'unknown',
    'a manager learns nothing about another organization’s contact'
  );

  perform test_assert(
    (select count(*) from campaign_recipients) =
    (select count(*) from campaign_recipients where organization_id = (select id from fixture where key = 'org')),
    'every outbox row visible belongs to this organization'
  );

  reset role;
end;
$$;

-- =============================================================================
-- Building an audience from ids the app resolved.
--
-- A dynamic list is a saved filter, not a set of rows, so there are no members
-- to read — the app resolves it and hands over contact ids. Which means this
-- function is handed uuids by a caller, and must not assume they are the
-- caller's to send to.
-- =============================================================================
do $$
declare
  v_org    uuid := (select id from fixture where key = 'org');
  v_theirs uuid := (select id from fixture where key = 'theirs_contact');
  v_id     uuid;
  v_a      uuid;
  v_b      uuid;
  v_n      integer;
begin
  raise notice 'Audience from ids:';

  insert into contacts (organization_id, first_name, email, marketing_consent, consent_at)
  values (v_org, 'Ida', 'ida@example.com', 'express', now()) returning id into v_a;
  insert into contacts (organization_id, first_name, email, marketing_consent, consent_at)
  values (v_org, 'Ivo', 'ivo@example.com', 'express', now()) returning id into v_b;

  insert into campaigns (organization_id, name, subject, body, status)
  values (v_org, 'From a filter', 'Hi', 'Body', 'draft') returning id into v_id;

  -- A campaign with no list at all: a dynamic audience does not need one.
  v_n := build_campaign_audience_for(v_id, array[v_a, v_b]);
  perform test_assert(v_n = 2, 'the ids it was given are queued');
  perform test_assert(recipient_status(v_id, v_a) = 'pending', 'and are ready to send');

  v_n := build_campaign_audience_for(v_id, array[v_a, v_b]);
  perform test_assert(v_n = 0, 'handing over the same ids twice queues nobody again');

  -- The organization is re-checked against the campaign rather than trusted
  -- from the ids: a definer function handed uuids must assume they could be
  -- anybody's.
  v_n := build_campaign_audience_for(v_id, array[v_theirs]);
  perform test_assert(v_n = 0, 'a contact from another organization is refused');
  perform test_assert(
    recipient_status(v_id, v_theirs) is null,
    'and no row is written for them at all'
  );

  perform test_assert(
    build_campaign_audience_for(v_id, null) = 0,
    'no ids at all is nothing to do, not an error'
  );

  insert into fixture values ('from_ids', v_id), ('ida', v_a), ('ivo', v_b);
end;
$$;

-- =============================================================================
-- Clearing an audience, and what cannot be cleared.
-- =============================================================================
do $$
declare
  v_id uuid := (select id from fixture where key = 'from_ids');
  v_a  uuid := (select id from fixture where key = 'ida');
  v_n  integer;
begin
  raise notice 'Clearing an audience:';

  -- One of them has already gone out. Clearing must not erase the record of a
  -- message that was actually delivered.
  update campaign_recipients set status = 'sent', sent_at = now()
  where campaign_id = v_id and contact_id = v_a;

  v_n := clear_campaign_audience(v_id);
  perform test_assert(v_n = 1, 'only the rows that have not been sent are removed');
  perform test_assert(
    recipient_status(v_id, v_a) = 'sent',
    'the one already sent survives, because it is the record that it happened'
  );

  -- And once a campaign is under way, neither adding nor removing is allowed:
  -- somebody would receive a message the person who approved it never saw
  -- being sent.
  update campaigns set status = 'sending' where id = v_id;

  begin
    perform clear_campaign_audience(v_id);
    raise exception 'TEST FAILED: cleared an audience mid-send';
  exception
    when others then
      if position('TEST FAILED' in sqlerrm) > 0 then raise; end if;
      raise notice '  ok: an audience cannot be cleared once sending has started';
  end;

  begin
    perform build_campaign_audience_for(v_id, array[(select id from fixture where key = 'ivo')]);
    raise exception 'TEST FAILED: added a recipient mid-send';
  exception
    when others then
      if position('TEST FAILED' in sqlerrm) > 0 then raise; end if;
      raise notice '  ok: nobody can be added once sending has started';
  end;
end;
$$;

-- =============================================================================
-- Who may build one.
-- =============================================================================
do $$
declare
  v_theirs uuid := (select id from fixture where key = 'theirs_campaign');
  v_mine   uuid := (select id from fixture where key = 'from_ids');
begin
  raise notice 'Who may build an audience:';

  set local role authenticated;
  perform sign_in_as('rep_auth');

  begin
    perform build_campaign_audience_for(v_mine, array[(select id from fixture where key = 'ida')]);
    raise exception 'TEST FAILED: a rep built an audience';
  exception
    when others then
      if position('TEST FAILED' in sqlerrm) > 0 then raise; end if;
      raise notice '  ok: a rep cannot build an audience';
  end;

  perform sign_in_as('mgr_auth');

  begin
    perform build_campaign_audience_for(v_theirs, array[(select id from fixture where key = 'ida')]);
    raise exception 'TEST FAILED: built another organization’s audience from ids';
  exception
    when others then
      if position('TEST FAILED' in sqlerrm) > 0 then raise; end if;
      raise notice '  ok: another organization’s campaign is out of reach here too';
  end;

  reset role;
end;
$$;

-- =============================================================================
-- Which links were clicked.
--
-- email_events is unreadable by signed-in users on purpose — it carries no
-- organization_id, so no policy could scope it. This function is the one door
-- into it, and it must open exactly one campaign's worth.
-- =============================================================================
do $$
declare
  v_id   uuid := (select id from fixture where key = 'campaign');
  v_good uuid := (select id from fixture where key = 'good');
  v_r    text;
  v_rows integer;
  v_url  text;
  v_ppl  integer;
begin
  raise notice 'Links clicked:';

  select provider_id into v_r
  from campaign_recipients where campaign_id = v_id and contact_id = v_good;

  -- The same person clicking the same link three times, and one other link.
  perform record_email_event(v_r, 'email.clicked', 'good@example.com',
    '{"data":{"click":{"link":"https://example.com/offer"}}}'::jsonb);
  perform record_email_event(v_r, 'email.clicked', 'good@example.com',
    '{"data":{"click":{"link":"https://example.com/offer"}}}'::jsonb);
  perform record_email_event(v_r, 'email.clicked', 'good@example.com',
    '{"data":{"click":{"link":"https://example.com/offer"}}}'::jsonb);
  perform record_email_event(v_r, 'email.clicked', 'good@example.com',
    '{"data":{"click":{"link":"https://example.com/terms"}}}'::jsonb);

  select count(*) into v_rows from campaign_link_clicks(v_id);
  perform test_assert(v_rows = 2, 'each distinct link is one row');

  select url, people into v_url, v_ppl from campaign_link_clicks(v_id) limit 1;
  perform test_assert(
    v_url = 'https://example.com/offer' and v_ppl = 1,
    'the busiest link leads, counted by people rather than by raw clicks'
  );

  perform test_assert(
    (select clicks from campaign_link_clicks(v_id) where url = 'https://example.com/offer') = 3,
    'and the raw clicks are still there beside it'
  );

  -- A click event with no link in the payload is a malformed event, not a row
  -- reading "null" in somebody's report.
  perform record_email_event(v_r, 'email.clicked', 'good@example.com', '{"data":{}}'::jsonb);
  perform test_assert(
    (select count(*) from campaign_link_clicks(v_id)) = 2,
    'an event with no link in it is left out rather than shown as blank'
  );
end;
$$;

do $$
declare
  v_theirs uuid := (select id from fixture where key = 'theirs_campaign');
  v_mine   uuid := (select id from fixture where key = 'campaign');
begin
  set local role authenticated;
  perform sign_in_as('rep_auth');

  -- Reading a report is not a manager action: anybody who can see the campaign
  -- can see how it did.
  perform test_assert(
    (select count(*) from campaign_link_clicks(v_mine)) = 2,
    'a rep can read the click report for their own organization'
  );

  begin
    perform campaign_link_clicks(v_theirs);
    raise exception 'TEST FAILED: read another organization’s clicks';
  exception
    when others then
      if position('TEST FAILED' in sqlerrm) > 0 then raise; end if;
      raise notice '  ok: another organization’s clicks are out of reach';
  end;

  -- And the raw table stays shut regardless — at the grant, before RLS is even
  -- consulted. Stronger than "returns no rows": there is nothing to select.
  begin
    perform count(*) from email_events;
    raise exception 'TEST FAILED: read the raw event log';
  exception
    when insufficient_privilege then
      raise notice '  ok: the raw event log is not readable by a signed-in user at all';
  end;

  reset role;
end;
$$;

-- =============================================================================
-- What the anonymous role may execute.
--
-- Added after a production advisory caught what these tests did not: `anon` had
-- EXECUTE on every one of the drain's functions. It matters more than it looks.
-- The anon key is published — it ships in the browser bundle — so `anon` is not
-- a role nobody holds, it is everybody. A stranger could have called
-- record_email_event through PostgREST and forged a bounce, suppressing any
-- address they chose, going around the webhook's signature check instead of
-- through it.
--
-- Two separate causes, which is why checking one is not enough:
--
--   * PUBLIC holds EXECUTE on every new function, and anon inherits through it
--   * Supabase's default privileges *also* grant anon EXECUTE directly, so
--     revoking from PUBLIC alone leaves that grant standing
--
-- Asserting on the role rather than on the revoke statements is what makes this
-- test worth having: it asks the question the attacker asks.
-- =============================================================================
do $$
declare
  v_fn text;
begin
  raise notice 'What anon may execute:';

  foreach v_fn in array array[
    'public.claim_campaign_batch(integer)',
    'public.finish_campaign_recipient(uuid, text, text, text, text)',
    'public.settle_campaigns()',
    'public.start_due_campaigns()',
    'public.record_email_event(text, text, text, jsonb)',
    'public.build_campaign_audience(uuid)',
    'public.build_campaign_audience_for(uuid, uuid[])',
    'public.clear_campaign_audience(uuid)',
    'public.campaign_link_clicks(uuid)',
    'public.contact_blocked_reason(uuid)'
  ]
  loop
    perform test_assert(
      not has_function_privilege('anon', v_fn::regprocedure, 'execute'),
      format('anon cannot execute %s', v_fn)
    );
  end loop;

  -- And the drain's own functions stay reachable by the role that runs it.
  foreach v_fn in array array[
    'public.claim_campaign_batch(integer)',
    'public.record_email_event(text, text, text, jsonb)',
    'public.settle_campaigns()'
  ]
  loop
    perform test_assert(
      has_function_privilege('service_role', v_fn::regprocedure, 'execute'),
      format('the service role can still execute %s', v_fn)
    );
  end loop;

  -- The public unsubscribe page has no session and must keep working: a person
  -- who asks to stop is not going to sign in first.
  perform test_assert(
    has_function_privilege('anon', 'public.unsubscribe_by_token(uuid)'::regprocedure, 'execute'),
    'but a stranger can still unsubscribe themselves'
  );
end;
$$;

rollback;
