-- -----------------------------------------------------------------------------
-- The two security advisories that are about this schema
--
-- Supabase's database linter reports 66 findings here. Most are it not being
-- able to see the design rather than anything to change:
--
--   * 60 are the application's own RPCs — add_invoice_line, create_sales_order,
--     restore_contact and the rest. They are security definer on purpose,
--     because they enforce rules RLS cannot express, and each checks the
--     caller's organization inside. Revoking execute would remove the
--     application's write surface.
--   * 2 are unsubscribe_by_token and unsubscribe_check, which anon is meant to
--     reach: an unsubscribe link is followed by somebody who is not signed in,
--     and unsubscribe-form.tsx already calls them "one of exactly two functions
--     anon may execute".
--   * 1 is email_events having no policies, which is what makes it unreadable.
--     The table carries no organization_id and belongs to the webhook; deny-all
--     is the intent, and adding a policy would be the bug.
--
-- These two are real.
-- -----------------------------------------------------------------------------

-- countries and country_subdivisions are ISO reference data: no
-- organization_id, shared by everybody, described in their own comments as
-- read-only to the app. They were exposed through PostgREST with row level
-- security switched off entirely, so nothing but the absence of a grant stood
-- between a signed-in user and a write.
--
-- Reading stays open to exactly who could read before. What changes is that
-- writing is refused by a policy rather than by nobody having considered it.
do $$
begin
  if to_regclass('public.countries') is not null then
    execute 'alter table public.countries enable row level security';
    execute 'drop policy if exists countries_read on public.countries';
    execute 'create policy countries_read on public.countries for select using (true)';
  end if;

  if to_regclass('public.country_subdivisions') is not null then
    execute 'alter table public.country_subdivisions enable row level security';
    execute 'drop policy if exists country_subdivisions_read on public.country_subdivisions';
    execute 'create policy country_subdivisions_read on public.country_subdivisions for select using (true)';
  end if;
end
$$;

-- stamp_deal_actor returns trigger, so it has no business being reachable at
-- /rest/v1/rpc, and execute on it was left at the default of everybody.
-- companies_normalise_geography is the same shape and was revoked in the
-- migration that added it; this one was missed.
--
-- The trigger is unaffected. A trigger function is invoked by the trigger
-- itself, which does not consult the calling role's execute privilege.
revoke execute on function public.stamp_deal_actor() from public, anon, authenticated;
