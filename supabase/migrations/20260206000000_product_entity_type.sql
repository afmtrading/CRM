-- =============================================================================
-- 'product' joins the record types
--
-- filter_entity_type names the records an organization can define fields,
-- option lists and saved views against. Products are about to become one of
-- them, so the value has to exist before anything can reference it.
--
-- It is alone in this file on purpose: PostgreSQL refuses to use a new enum
-- value in the same transaction that added it, so the next migration would fail
-- the moment it seeded a product option list.
-- =============================================================================

alter type filter_entity_type add value if not exists 'product';
