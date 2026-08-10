-- =============================================================================
-- Calendar sync
--
-- The same Google connection, reading the same account's calendar. Meetings
-- travel the path emails already do — matched to a contact by attendee address
-- and written to the timeline idempotently — so this adds a cursor and a state,
-- not a second kind of connection.
--
-- calendar_state exists because the calendar scope arrived after people had
-- already connected their mailboxes. Their stored credentials can read Gmail
-- and cannot read a calendar, and that must not take the mailbox down: Gmail
-- keeps working, the calendar half is marked unauthorised, and reconnecting
-- (which asks for the wider scope) sets it back to unknown so it is retried.
-- =============================================================================

do $$
begin
  if to_regclass('public.mailbox_connections') is null then
    raise exception 'Run the earlier migrations first — this one extends mailbox_connections.';
  end if;
end
$$;

alter table mailbox_connections
  add column if not exists calendar_sync_token text,
  add column if not exists calendar_state text not null default 'unknown';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mailbox_connections_calendar_state_check'
  ) then
    alter table mailbox_connections
      add constraint mailbox_connections_calendar_state_check
      check (calendar_state in ('unknown', 'active', 'unauthorised'));
  end if;
end
$$;

comment on column mailbox_connections.calendar_sync_token is
  'Google Calendar''s incremental cursor. Null means the next run does a bounded first read.';
comment on column mailbox_connections.calendar_state is
  'unknown = not yet tried, active = syncing, unauthorised = connected before the calendar scope existed.';

-- Column-level grants: a column absent from the list cannot be read at all.
-- The sync token stays out deliberately — it is a credential-shaped thing and
-- no signed-in user has any reason to read it. The state is shown in settings.
grant select (calendar_state) on mailbox_connections to authenticated;
