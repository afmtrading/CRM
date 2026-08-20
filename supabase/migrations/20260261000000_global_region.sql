-- =============================================================================
-- Global, at the top of the Sells To list
--
-- A tenth trading region, meaning everywhere. Some businesses genuinely answer
-- "where do you sell" with "anywhere there is stock", and until now saying so
-- meant ticking all nine regions — which reads as a considered list of nine
-- rather than as the single fact it is, and has to be revisited every time the
-- region list changes.
--
-- sort_order 0 puts it above North America, which is where a catch-all belongs:
-- somebody who wants it should not have to read past the specific answers to
-- find it, and somebody who does not is one line further down.
--
-- XG is in the ISO 3166-1 user-assigned X series, like the nine before it, so
-- it lives in the same table behind the same foreign key that based_in and
-- sells_in already point at. Nothing else changes: no column, no constraint, no
-- application code that has to learn about a special value.
--
-- A note on what this does NOT do. "Global" is a value in the list, not a
-- wildcard. A company that sells everywhere and says so with this will not
-- match a filter for "sells to Canada", because the filter compares stored
-- values and the stored value is XG. Teaching the filter that XG matches
-- everything would make it mean one thing in a query and another on a card,
-- which is the sort of split that turns a filter into a thing people stop
-- trusting. If matching is wanted later, it belongs in one place — the filter's
-- predicate — and it belongs there deliberately.
-- =============================================================================

insert into public.countries (code, name, kind, sort_order) values
  ('XG', 'Global', 'region', 0)
on conflict (code) do update
  set name = excluded.name, kind = excluded.kind, sort_order = excluded.sort_order;
