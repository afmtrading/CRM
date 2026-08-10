-- =============================================================================
-- A second sales tier.
--
-- Alone in its own migration: a new enum value cannot be used in the same
-- transaction that adds it.
--
--   sales_director  sees their own records and unassigned ones; may import,
--                   export and reassign
--   regular         "Sales rep" — sees only their own records, and nothing else
-- =============================================================================

alter type user_role add value if not exists 'sales_director';
