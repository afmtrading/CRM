-- =============================================================================
-- A "Company Rating" card on the business record
--
-- What a business is — its specialty market, what type of customer it is, what
-- it stocks, where it operates and how big it is — was scattered through the
-- Company info card alongside its phone number and address. Those are two
-- different questions: one is how to reach a company, the other is how to size
-- one up. They now have a card each.
--
-- Adding a card means widening the check constraint that says where a custom
-- field may be filed. The constraint is the reason this is a migration rather
-- than a change to a list in the code.
-- =============================================================================

alter table custom_field_definitions drop constraint if exists custom_field_definitions_card_check;
alter table custom_field_definitions add constraint custom_field_definitions_card_check
  check (card in ('details', 'influence', 'additional', 'digital', 'pricing', 'rating'));

/*
 * The three fields that were asked for by name. Matched on label or key and
 * case-insensitively, because they were typed into a form rather than written
 * in a migration, and only moved off 'details' — a field already filed
 * somewhere deliberate is left where it is.
 *
 * Anything else a company keeps on its Company info card stays there. If a
 * field belongs under the rating and is not caught here, it can be moved in
 * Settings → Fields without touching the database.
 */
update custom_field_definitions
set card = 'rating'
where entity_type = 'company'
  and card = 'details'
  and (
    lower(label) in ('stock type', 'stock types', 'regions', 'region', 'size')
    or lower(key) in ('stock_type', 'stock_types', 'regions', 'region', 'size')
  );
