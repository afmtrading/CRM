-- =============================================================================
-- YouTube on the Digital card
--
-- The Digital card carries LinkedIn, Facebook, Instagram, TikTok and X. A
-- channel is where a lot of this trade actually happens — a liquidator's
-- walkthrough of a pallet is the listing — and until now it had to go in the
-- free-text "Other links" list, where nothing can filter or export it as a
-- field of its own.
--
-- Both records, because the card is on both and a person's channel and their
-- employer's are different facts.
--
-- Free text like its five neighbours: a handle or a full URL, tidied into
-- something clickable by socialUrl() when it is read. Storing what somebody
-- typed rather than a normalised form is what lets a channel URL that does not
-- fit the @handle shape — /channel/UC…, an old /c/ vanity path — survive being
-- saved.
-- =============================================================================

alter table public.contacts  add column if not exists youtube text;
alter table public.companies add column if not exists youtube text;

comment on column public.contacts.youtube is
  'YouTube channel — a handle or a full URL, as typed.';
comment on column public.companies.youtube is
  'YouTube channel — a handle or a full URL, as typed.';
