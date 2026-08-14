-- =============================================================================
-- Make row level security stop reading the users table once per row
--
-- THE BUG
--
-- Every policy in this schema was written the obvious way:
--
--   using (organization_id = current_org_id() and can_see_owned(owner_id))
--
-- `can_see_owned` takes the row's owner_id, so Postgres cannot hoist it: it is
-- inlined and evaluated once per row. Inside it are current_app_user_id() and
-- current_user_role(), each of which selects from public.users, and each of
-- those calls current_org_id(), which selects from public.users again.
--
-- So reading N rows performed on the order of 4N index lookups against users
-- before returning anything. Measured on 20,000 rows, seeded locally:
--
--   select count(*) from contacts   -- 3,520 ms   (3.7 ms with RLS off)
--   select count(*) from deals      -- 3,541 ms
--   select count(*) from deal_products -- 3,662 ms
--
-- Roughly a 950x tax on every list, every report and every export, paid on
-- every request, and invisible in development where the tables are small.
--
-- THE FIX
--
-- An argument-free STABLE function wrapped in a scalar subquery becomes an
-- InitPlan: the planner runs it once and reuses the value for every row. So
-- `current_org_id()` becomes `(select current_org_id())`, and can_see_owned is
-- expanded inline — a function taking a per-row argument can never be hoisted,
-- so the only way to get the constant parts out of the loop is to write them
-- out where the planner can see them.
--
--   select count(*) from contacts   -- 4.5 ms   (was 3,520)
--   select count(*) from deals      -- 4.9 ms   (was 3,541)
--   select count(*) from deal_products -- 24 ms (was 3,662; the rest is the
--                                        hashed EXISTS over deals, which is
--                                        the visibility rule doing real work)
--
-- WHAT IS NOT CHANGED
--
-- Nothing about who can see or do what. Every predicate below is the one that
-- was already there, with the same operators in the same order — only the
-- helper calls are wrapped, and can_see_owned is written out longhand as
-- exactly what its body says. The 402 assertions in supabase/tests pass
-- unchanged against these policies, which is the evidence that this is a
-- rewrite and not a redesign.
--
-- The helper functions themselves are deliberately left alone. Wrapping the
-- subqueries inside can_see_owned was tried first and made things worse: a SQL
-- function whose body contains a subquery can no longer be inlined, so it
-- became a real per-row function call and the same query took 8.6 seconds.
-- The wrapping has to happen at the call site, which is here.
--
-- Generated from pg_policy rather than typed out, so a predicate cannot drift
-- from the one it replaces.
-- =============================================================================

drop policy if exists activities_delete on public.activities;
create policy activities_delete on public.activities
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((select public.can_manage_records()) OR (owner_id = (select public.current_app_user_id())))));

drop policy if exists activities_insert on public.activities;
create policy activities_insert on public.activities
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists activities_select on public.activities;
create policy activities_select on public.activities
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((select public.can_manage_records()) OR (owner_id = (select public.current_app_user_id())) OR (related_to_type = 'company'::related_to_type) OR ((related_to_type = 'contact'::related_to_type) AND (EXISTS ( SELECT 1
   FROM contacts c
  WHERE (c.id = activities.related_to_id)))) OR ((related_to_type = 'deal'::related_to_type) AND (EXISTS ( SELECT 1
   FROM deals d
  WHERE (d.id = activities.related_to_id)))))));

drop policy if exists activities_update on public.activities;
create policy activities_update on public.activities
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND ((select public.can_manage_records()) OR (owner_id = (select public.current_app_user_id())))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists assignment_rules_select on public.assignment_rules;
create policy assignment_rules_select on public.assignment_rules
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists assignment_rules_write on public.assignment_rules;
create policy assignment_rules_write on public.assignment_rules
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists campaign_recipients_select on public.campaign_recipients;
create policy campaign_recipients_select on public.campaign_recipients
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists campaigns_delete on public.campaigns;
create policy campaigns_delete on public.campaigns
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())));

drop policy if exists campaigns_insert on public.campaigns;
create policy campaigns_insert on public.campaigns
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())));

drop policy if exists campaigns_select on public.campaigns;
create policy campaigns_select on public.campaigns
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists campaigns_update on public.campaigns;
create policy campaigns_update on public.campaigns
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())))
  with check ((organization_id = (select public.current_org_id())));

drop policy if exists companies_delete on public.companies;
create policy companies_delete on public.companies
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists companies_insert on public.companies;
create policy companies_insert on public.companies
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((deleted_at IS NULL) OR (select public.is_org_admin()))));

drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND ((deleted_at IS NULL) OR (select public.is_org_admin()))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists company_tags_select on public.company_tags;
create policy company_tags_select on public.company_tags
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (EXISTS ( SELECT 1
   FROM companies p
  WHERE (p.id = company_tags.company_id)))));

drop policy if exists company_tags_write on public.company_tags;
create policy company_tags_write on public.company_tags
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND (EXISTS ( SELECT 1
   FROM companies p
  WHERE (p.id = company_tags.company_id)))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists contact_products_select on public.contact_products;
create policy contact_products_select on public.contact_products
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (EXISTS ( SELECT 1
   FROM contacts c
  WHERE (c.id = contact_products.contact_id)))));

drop policy if exists contact_products_write on public.contact_products;
create policy contact_products_write on public.contact_products
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND (EXISTS ( SELECT 1
   FROM contacts c
  WHERE (c.id = contact_products.contact_id)))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND (EXISTS ( SELECT 1
   FROM contacts c
  WHERE (c.id = contact_products.contact_id)))));

drop policy if exists contact_tags_select on public.contact_tags;
create policy contact_tags_select on public.contact_tags
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (EXISTS ( SELECT 1
   FROM contacts p
  WHERE (p.id = contact_tags.contact_id)))));

drop policy if exists contact_tags_write on public.contact_tags;
create policy contact_tags_write on public.contact_tags
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND (EXISTS ( SELECT 1
   FROM contacts p
  WHERE (p.id = contact_tags.contact_id)))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists contacts_insert on public.contacts;
create policy contacts_insert on public.contacts
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((select public.can_see_all_records()) or owner_id = (select public.current_app_user_id()) or (owner_id is null and (select public.can_see_unassigned()))) AND ((deleted_at IS NULL) OR (select public.is_org_admin()))));

drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND ((select public.can_see_all_records()) or owner_id = (select public.current_app_user_id()) or (owner_id is null and (select public.can_see_unassigned()))) AND ((deleted_at IS NULL) OR (select public.is_org_admin()))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists custom_field_definitions_select on public.custom_field_definitions;
create policy custom_field_definitions_select on public.custom_field_definitions
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists custom_field_definitions_write on public.custom_field_definitions;
create policy custom_field_definitions_write on public.custom_field_definitions
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists deal_products_select on public.deal_products;
create policy deal_products_select on public.deal_products
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (EXISTS ( SELECT 1
   FROM deals d
  WHERE (d.id = deal_products.deal_id)))));

drop policy if exists deal_products_write on public.deal_products;
create policy deal_products_write on public.deal_products
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND (EXISTS ( SELECT 1
   FROM deals d
  WHERE (d.id = deal_products.deal_id)))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND (EXISTS ( SELECT 1
   FROM deals d
  WHERE (d.id = deal_products.deal_id)))));

drop policy if exists deal_stage_history_select on public.deal_stage_history;
create policy deal_stage_history_select on public.deal_stage_history
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (EXISTS ( SELECT 1
   FROM deals d
  WHERE (d.id = deal_stage_history.deal_id)))));

drop policy if exists deals_delete on public.deals;
create policy deals_delete on public.deals
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists deals_insert on public.deals;
create policy deals_insert on public.deals
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists deals_select on public.deals;
create policy deals_select on public.deals
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((select public.can_see_all_records()) or owner_id = (select public.current_app_user_id()) or (owner_id is null and (select public.can_see_unassigned()))) AND ((deleted_at IS NULL) OR (select public.is_org_admin()))));

drop policy if exists deals_update on public.deals;
create policy deals_update on public.deals
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND ((select public.can_see_all_records()) or owner_id = (select public.current_app_user_id()) or (owner_id is null and (select public.can_see_unassigned()))) AND ((deleted_at IS NULL) OR (select public.is_org_admin()))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists email_list_members_delete on public.email_list_members;
create policy email_list_members_delete on public.email_list_members
  for delete to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists email_list_members_insert on public.email_list_members;
create policy email_list_members_insert on public.email_list_members
  for insert to authenticated
  with check ((organization_id = (select public.current_org_id())));

drop policy if exists email_list_members_select on public.email_list_members;
create policy email_list_members_select on public.email_list_members
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists email_lists_delete on public.email_lists;
create policy email_lists_delete on public.email_lists
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((created_by = (select public.current_app_user_id())) OR (select public.is_org_admin()))));

drop policy if exists email_lists_insert on public.email_lists;
create policy email_lists_insert on public.email_lists
  for insert to authenticated
  with check ((organization_id = (select public.current_org_id())));

drop policy if exists email_lists_select on public.email_lists;
create policy email_lists_select on public.email_lists
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists email_lists_update on public.email_lists;
create policy email_lists_update on public.email_lists
  for update to authenticated
  using ((organization_id = (select public.current_org_id())))
  with check ((organization_id = (select public.current_org_id())));

drop policy if exists email_suppressions_delete on public.email_suppressions;
create policy email_suppressions_delete on public.email_suppressions
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists email_suppressions_insert on public.email_suppressions;
create policy email_suppressions_insert on public.email_suppressions
  for insert to authenticated
  with check ((organization_id = (select public.current_org_id())));

drop policy if exists email_suppressions_select on public.email_suppressions;
create policy email_suppressions_select on public.email_suppressions
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists field_options_read on public.field_options;
create policy field_options_read on public.field_options
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists field_options_write on public.field_options;
create policy field_options_write on public.field_options
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists import_jobs_select on public.import_jobs;
create policy import_jobs_select on public.import_jobs
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_bulk_records())));

drop policy if exists import_jobs_write on public.import_jobs;
create policy import_jobs_write on public.import_jobs
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_bulk_records())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_bulk_records())));

drop policy if exists invoice_lines_select on public.invoice_lines;
create policy invoice_lines_select on public.invoice_lines
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (EXISTS ( SELECT 1
   FROM invoices i
  WHERE (i.id = invoice_lines.invoice_id)))));

drop policy if exists invoice_payments_insert on public.invoice_payments;
create policy invoice_payments_insert on public.invoice_payments
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND (EXISTS ( SELECT 1
   FROM invoices i
  WHERE (i.id = invoice_payments.invoice_id)))));

drop policy if exists invoice_payments_select on public.invoice_payments;
create policy invoice_payments_select on public.invoice_payments
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (EXISTS ( SELECT 1
   FROM invoices i
  WHERE (i.id = invoice_payments.invoice_id)))));

drop policy if exists invoices_delete on public.invoices;
create policy invoices_delete on public.invoices
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists invoices_insert on public.invoices;
create policy invoices_insert on public.invoices
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((select public.can_see_all_records()) or owner_id = (select public.current_app_user_id()) or (owner_id is null and (select public.can_see_unassigned())))));

drop policy if exists invoices_update on public.invoices;
create policy invoices_update on public.invoices
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND ((select public.can_see_all_records()) or owner_id = (select public.current_app_user_id()) or (owner_id is null and (select public.can_see_unassigned())))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists lead_score_rules_select on public.lead_score_rules;
create policy lead_score_rules_select on public.lead_score_rules
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists lead_score_rules_write on public.lead_score_rules;
create policy lead_score_rules_write on public.lead_score_rules
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists mailbox_connections_select on public.mailbox_connections;
create policy mailbox_connections_select on public.mailbox_connections
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((user_id = (select public.current_app_user_id())) OR (select public.is_org_admin()))));

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (user_id = (select public.current_app_user_id()))));

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (user_id = (select public.current_app_user_id()))));

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (user_id = (select public.current_app_user_id()))))
  with check (((organization_id = (select public.current_org_id())) AND (user_id = (select public.current_app_user_id()))));

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select to authenticated
  using ((id IN ( SELECT current_user_org_ids() AS current_user_org_ids)));

drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update to authenticated
  using (((id = (select public.current_org_id())) AND (select public.is_org_admin())))
  with check ((id = (select public.current_org_id())));

drop policy if exists pipelines_select on public.pipelines;
create policy pipelines_select on public.pipelines
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists pipelines_write on public.pipelines;
create policy pipelines_write on public.pipelines
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists products_delete on public.products;
create policy products_delete on public.products
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists products_insert on public.products;
create policy products_insert on public.products
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())));

drop policy if exists products_select on public.products;
create policy products_select on public.products
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists products_update on public.products;
create policy products_update on public.products
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())));

drop policy if exists sales_order_lines_select on public.sales_order_lines;
create policy sales_order_lines_select on public.sales_order_lines
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (EXISTS ( SELECT 1
   FROM sales_orders o
  WHERE (o.id = sales_order_lines.sales_order_id)))));

drop policy if exists sales_order_lines_write on public.sales_order_lines;
create policy sales_order_lines_write on public.sales_order_lines
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND (EXISTS ( SELECT 1
   FROM sales_orders o
  WHERE (o.id = sales_order_lines.sales_order_id)))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND (EXISTS ( SELECT 1
   FROM sales_orders o
  WHERE (o.id = sales_order_lines.sales_order_id)))));

drop policy if exists sales_order_payments_insert on public.sales_order_payments;
create policy sales_order_payments_insert on public.sales_order_payments
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND (EXISTS ( SELECT 1
   FROM sales_orders o
  WHERE (o.id = sales_order_payments.sales_order_id)))));

drop policy if exists sales_order_payments_select on public.sales_order_payments;
create policy sales_order_payments_select on public.sales_order_payments
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (EXISTS ( SELECT 1
   FROM sales_orders o
  WHERE (o.id = sales_order_payments.sales_order_id)))));

drop policy if exists sales_orders_delete on public.sales_orders;
create policy sales_orders_delete on public.sales_orders
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists sales_orders_insert on public.sales_orders;
create policy sales_orders_insert on public.sales_orders
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists sales_orders_select on public.sales_orders;
create policy sales_orders_select on public.sales_orders
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((select public.can_see_all_records()) or owner_id = (select public.current_app_user_id()) or (owner_id is null and (select public.can_see_unassigned())))));

drop policy if exists sales_orders_update on public.sales_orders;
create policy sales_orders_update on public.sales_orders
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_write_records()) AND ((select public.can_see_all_records()) or owner_id = (select public.current_app_user_id()) or (owner_id is null and (select public.can_see_unassigned())))))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists saved_filters_delete on public.saved_filters;
create policy saved_filters_delete on public.saved_filters
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((user_id = (select public.current_app_user_id())) OR (select public.is_org_admin()))));

drop policy if exists saved_filters_insert on public.saved_filters;
create policy saved_filters_insert on public.saved_filters
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND ((user_id = (select public.current_app_user_id())) OR (user_id IS NULL))));

drop policy if exists saved_filters_select on public.saved_filters;
create policy saved_filters_select on public.saved_filters
  for select to authenticated
  using (((organization_id = (select public.current_org_id())) AND (is_shared OR (user_id = (select public.current_app_user_id())))));

drop policy if exists saved_filters_update on public.saved_filters;
create policy saved_filters_update on public.saved_filters
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((user_id = (select public.current_app_user_id())) OR (select public.is_org_admin()))))
  with check ((organization_id = (select public.current_org_id())));

drop policy if exists sending_domains_delete on public.sending_domains;
create policy sending_domains_delete on public.sending_domains
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists sending_domains_insert on public.sending_domains;
create policy sending_domains_insert on public.sending_domains
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists sending_domains_select on public.sending_domains;
create policy sending_domains_select on public.sending_domains
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists sending_domains_update on public.sending_domains;
create policy sending_domains_update on public.sending_domains
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())))
  with check ((organization_id = (select public.current_org_id())));

drop policy if exists stages_select on public.stages;
create policy stages_select on public.stages
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists stages_write on public.stages;
create policy stages_write on public.stages
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists stock_adjustments_select on public.stock_adjustments;
create policy stock_adjustments_select on public.stock_adjustments
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists stock_bins_select on public.stock_bins;
create policy stock_bins_select on public.stock_bins
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists stock_bins_write on public.stock_bins;
create policy stock_bins_write on public.stock_bins
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())));

drop policy if exists stock_levels_select on public.stock_levels;
create policy stock_levels_select on public.stock_levels
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists stock_locations_select on public.stock_locations;
create policy stock_locations_select on public.stock_locations
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists stock_locations_write on public.stock_locations;
create policy stock_locations_write on public.stock_locations
  for all to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())));

drop policy if exists tags_delete on public.tags;
create policy tags_delete on public.tags
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())));

drop policy if exists tags_insert on public.tags;
create policy tags_insert on public.tags
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_write_records())));

drop policy if exists tags_select on public.tags;
create policy tags_select on public.tags
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists tags_update on public.tags;
create policy tags_update on public.tags
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())))
  with check (((organization_id = (select public.current_org_id())) AND (select public.can_manage_records())));

drop policy if exists users_delete on public.users;
create policy users_delete on public.users
  for delete to authenticated
  using (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists users_insert on public.users;
create policy users_insert on public.users
  for insert to authenticated
  with check (((organization_id = (select public.current_org_id())) AND (select public.is_org_admin())));

drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select to authenticated
  using ((organization_id = (select public.current_org_id())));

drop policy if exists users_update on public.users;
create policy users_update on public.users
  for update to authenticated
  using (((organization_id = (select public.current_org_id())) AND ((select public.is_org_admin()) OR (id = (select public.current_app_user_id())))))
  with check ((organization_id = (select public.current_org_id())));

