-- =============================================================================
-- Adds the 'multiselect' custom field type.
--
-- Alone in its own migration on purpose: a new enum value cannot be used in the
-- same transaction that adds it, so this has to commit before the next
-- migration references it.
-- =============================================================================

alter type custom_field_type add value if not exists 'multiselect';
