-- =============================================================================
-- Retire "Interested in"
--
-- The field on a contact that recorded which products they had asked about,
-- and the join table behind it.
--
-- It was never a record of anything that happened — a deal line is what a
-- person actually bought, and an activity is what they actually asked. This
-- sat between the two as a hand-maintained list that nothing else read: no
-- filter, no report, no export column. The reverse view on the product page
-- ("Interested contacts") was its only other reader, and it goes with it.
--
-- Dropping the table rather than leaving it unwritten. An empty table behind a
-- removed form is schema that still enforces, still shows up in a full export,
-- and still looks like a feature to the next person reading the migrations.
-- Same call as 20260250 made for country_subdivisions.
--
-- The policies, indexes and grants are owned by the table and go with it; the
-- explicit drops are only there so a re-run finds nothing to do.
-- =============================================================================

drop policy if exists contact_products_select on public.contact_products;
drop policy if exists contact_products_write on public.contact_products;

drop table if exists public.contact_products;
