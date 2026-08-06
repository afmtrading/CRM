-- =============================================================================
-- FLO CRM — the two organizations the system starts with (PRD 5.1)
--
-- Provisioning an organization is an internal admin action, not a signup, so
-- the first two are created here. Each one picks up a default pipeline and
-- stages from the organizations_seed_pipeline trigger.
-- =============================================================================

insert into organizations (name, slug, default_currency, primary_color)
values
  ('AFM Global Trading', 'afm-global-trading', 'CAD', '#0f766e'),
  ('FLO Ventures Inc.',  'flo-ventures',       'CAD', '#4338ca')
on conflict (slug) do nothing;

-- A starter set of lead scoring rules per organization, so 6.5 is demonstrable
-- on day one. Admins edit or delete these in Settings, no deploy required.
insert into lead_score_rules (organization_id, field, condition, value, points)
select o.id, r.field, r.condition::score_condition, r.value, r.points
from organizations o
cross join (values
  ('source', 'equals',    'website', 10),
  ('email',  'is_filled', null,       5),
  ('phone',  'is_filled', null,       5)
) as r(field, condition, value, points)
where not exists (
  select 1 from lead_score_rules l where l.organization_id = o.id
);
