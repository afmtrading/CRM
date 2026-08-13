-- =============================================================================
-- Deals carry the organization's own fields too
--
-- Contacts, companies and products have taken organization-defined fields since
-- early on. A deal was the one record that could not, which meant anything a
-- desk needed to track about a deal — an incoterm, a shipping window, a broker
-- reference — had nowhere to live but the notes.
--
-- custom_field_definitions already understood 'deal': filter_entity_type has
-- carried the value since the first schema, and the filter builder has been
-- offering deal fields as filterable columns the whole time. The only thing
-- missing was somewhere on the deal to put the values.
-- =============================================================================

alter table deals
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

comment on column deals.custom_fields is
  'Organization-defined values, keyed by custom_field_definitions.key. Written as custom.<key> by the deal form.';

-- The same index contacts and companies carry: containment queries against a
-- json blob are unusable without it, and the filter builder generates exactly
-- those.
create index if not exists deals_custom_fields_idx on deals using gin (custom_fields);

-- -----------------------------------------------------------------------------
-- The cards a deal field can be placed on
--
-- 'details' is the card already on the deal record — status, stage, value,
-- owner, dates. 'additional' is the second card the form and the record page
-- now draw, which is where anything that is not one of those belongs.
--
-- Both values are already allowed by the constraint; it is restated here so the
-- set is visible in the migration that starts using it for a third record type
-- rather than only in the one that first defined it.
-- -----------------------------------------------------------------------------
alter table custom_field_definitions drop constraint if exists custom_field_definitions_card_check;
alter table custom_field_definitions add constraint custom_field_definitions_card_check
  check (card in ('details', 'influence', 'additional', 'digital', 'pricing', 'rating'));
