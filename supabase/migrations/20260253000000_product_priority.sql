-- =============================================================================
-- Products get a priority
--
-- Priority is asked on a contact and on a company, and it was asked with a
-- different control on each — chips here, a dropdown there — which made the
-- same question look like a different kind of question depending on which
-- record you were looking at. The controls are now one thing; a product had no
-- priority to make consistent, so this is that column.
--
-- Marketplaces are not listed here on purpose: a marketplace is a company and
-- reads the company's priority, as 20260247 set out. There is nothing to add.
--
-- ONE CONCEPT, FOUR LISTS
--
-- Seeded to match, separate after that — the same reasoning 20260247 gave for
-- companies. Every other select field in this schema is scoped to an entity and
-- Settings → Fields is grouped that way; a shared list would be the only one
-- that is not. A Critical account may hold a Standard line, and one list would
-- make those the same statement.
-- =============================================================================

alter table public.products
  add column if not exists priority text;

comment on column public.products.priority is
  'How much this line matters. Drawn from the product priority list in Settings → Fields, seeded to match the contacts'' one.';

-- -----------------------------------------------------------------------------
-- The list
--
-- "Medium" rather than "Standard", which is what 20260251 renamed the other two
-- to. Seeding the old word here would put it straight back on a screen it was
-- just taken off.
-- -----------------------------------------------------------------------------

insert into public.field_options (organization_id, entity_type, field_key, value, color, "order")
select o.id, 'product', 'priority', v.value, v.color, v.ord
from public.organizations o
cross join (values
  ('Critical', 'red',    0),
  ('High',     'orange', 1),
  ('Medium',   'blue',   2),
  ('Low',      'slate',  3)
) as v(value, color, ord)
on conflict do nothing;

/*
 * An organization that has renamed its contact priorities keeps them: whatever
 * it uses there is copied across, so the product list reads like the one people
 * already know rather than the four seeded above. Names that match one of those
 * four are already present and the unique key turns them away, so this adds the
 * organization's own words and nothing twice.
 */
insert into public.field_options (organization_id, entity_type, field_key, value, color, "order")
select o.organization_id, 'product', 'priority', o.value, o.color, o."order"
from public.field_options o
where o.entity_type = 'contact' and o.field_key = 'priority'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Organizations created from here on
--
-- Both inserts above reach the organizations that exist today. A new one is
-- seeded by seed_field_options, and that function was never told about the
-- company priority list 20260247 added — so an organization created since then
-- has been getting an empty Priority on its company form. Fixing that here
-- rather than leaving a second, quieter version of the same bug.
--
-- The rename goes in at the same time: 20260251 replaced Standard with Medium
-- on the lists that exist, but a new organization was still being seeded with
-- the old word.
--
-- Rebuilt from its own definition rather than retyped, the way 20260238 did it,
-- so the twenty-odd lists it already seeds cannot be lost to a transcription
-- slip. It is deliberately not re-run over existing organizations: that would
-- put back options an administrator has deleted.
-- -----------------------------------------------------------------------------

do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'seed_field_options';

  if v_def is null then
    raise exception 'seed_field_options is missing — run the earlier migrations first';
  end if;

  -- Already done.
  if position('''product'', ''priority''' in v_def) > 0 then
    return;
  end if;

  v_def := replace(v_def,
    '(''contact'', ''priority'',         ''Low'',            ''slate'',  1),
    (''contact'', ''priority'',         ''Standard'',       ''blue'',   2),
    (''contact'', ''priority'',         ''High'',           ''amber'',  3),
    (''contact'', ''priority'',         ''Critical'',       ''red'',    4),',
    '(''contact'', ''priority'',         ''Low'',            ''slate'',  1),
    (''contact'', ''priority'',         ''Medium'',         ''blue'',   2),
    (''contact'', ''priority'',         ''High'',           ''amber'',  3),
    (''contact'', ''priority'',         ''Critical'',       ''red'',    4),

    (''company'', ''priority'',         ''Low'',            ''slate'',  1),
    (''company'', ''priority'',         ''Medium'',         ''blue'',   2),
    (''company'', ''priority'',         ''High'',           ''amber'',  3),
    (''company'', ''priority'',         ''Critical'',       ''red'',    4),

    (''product'', ''priority'',         ''Low'',            ''slate'',  1),
    (''product'', ''priority'',         ''Medium'',         ''blue'',   2),
    (''product'', ''priority'',         ''High'',           ''amber'',  3),
    (''product'', ''priority'',         ''Critical'',       ''red'',    4),');

  if position('''product'', ''priority''' in v_def) = 0 then
    raise exception 'Could not find the priority list to extend';
  end if;

  execute v_def;
end;
$$;
