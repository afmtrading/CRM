-- =============================================================================
-- Two more roles.
--
-- Alone in its own migration: a new enum value cannot be used in the same
-- transaction that adds it.
--
-- 'regular' is kept rather than renamed — it is the sales rep, and renaming it
-- would rewrite every existing row for a label change. The UI calls it
-- "Sales rep".
-- =============================================================================

alter type user_role add value if not exists 'manager';
alter type user_role add value if not exists 'readonly';
