-- =============================================================================
-- A second email address on a contact
--
-- A buyer who gives you a personal address as well as the one on their card is
-- ordinary in this trade, and until now the second one had nowhere to go: it
-- went in Notes, where nothing can export it, filter on it, or find the person
-- by it.
--
-- Contacts only. A company's address is the business's, and there is no second
-- one in the same sense — a second person at the company is a second contact.
--
-- Free text, nullable, exactly like `email` beside it, which is also plain
-- nullable text with no format constraint. What somebody typed is what gets
-- stored; the app decides what is worth sending to.
--
-- What this deliberately does NOT do:
--
--   It is not a second sending address. Marketing consent, mailability,
--   campaign audiences and suppressions all key off `email` alone, and every
--   one of them would have to say what it means for an address the contact may
--   never have consented on. Until that is decided, this is a record-keeping
--   field: somewhere to keep an address, not somewhere to send from.
--
--   It is not part of duplicate detection. Two contacts sharing a secondary
--   address is not the signal that two sharing a primary one is.
--
--   It gets no index. `email` has one — contacts_org_email_idx, on
--   (organization_id, lower(email)) — because search and the duplicate check
--   read it. Nothing reads this yet, and an index nothing uses is a cost on
--   every write for nothing. Add the matching one the day search starts
--   looking here.
--
-- The app cannot use this column until the migration has been applied: the
-- contact page selects columns by name and would error on one the database
-- does not have. Apply first, then wire up the field.
-- =============================================================================

alter table public.contacts add column if not exists secondary_email text;

comment on column public.contacts.secondary_email is
  'A second email address, as typed. Record-keeping only: consent, campaigns and suppressions all key off email.';
