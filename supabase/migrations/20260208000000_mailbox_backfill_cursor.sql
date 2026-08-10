-- =============================================================================
-- Backfill cursor
--
-- Importing a mailbox's history used to be a single run: fetch the newest
-- messages in the window, then anchor to now. Anything older than that first
-- batch was never imported and nothing came back for it, so "backfilling 30
-- days" delivered whatever fitted in one run and quietly stopped.
--
-- This column is how far back the import has reached. Each run takes another
-- chunk and moves it earlier, so history drains over successive runs while new
-- mail continues to arrive through the incremental cursor — the two are
-- independent, and the backfill never delays today's email.
--
-- Null means the walk has not started. It is complete once it reaches the far
-- edge of the window, which is derived from backfill_days rather than stored:
-- widening the window on the Mailboxes page therefore resumes the walk instead
-- of needing a reset.
-- =============================================================================

do $$
begin
  if to_regclass('public.mailbox_connections') is null then
    raise exception 'Run the earlier migrations first — this one extends mailbox_connections.';
  end if;
end
$$;

alter table mailbox_connections
  add column if not exists backfill_until timestamptz;

comment on column mailbox_connections.backfill_until is
  'History has been imported back to this instant. Null = not started. Complete once it passes now() - backfill_days.';

-- The grant on this table is a column list, and a column absent from it cannot
-- be read at all. Adding one means adding it here too — the refresh token is
-- the one that stays out, deliberately.
grant select (backfill_until) on mailbox_connections to authenticated;
