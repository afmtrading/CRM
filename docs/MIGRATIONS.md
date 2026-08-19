# Migrations

`supabase/migrations/` is the source of truth for the schema. Every file in it
is applied to production, in filename order, and the database records that it
ran in `supabase_migrations.schema_migrations`.

## How to apply one

Apply migrations against the project directly rather than pasting SQL into the
Supabase SQL editor. Pasting works, but it changes the schema without writing a
row to the ledger, and the two drift apart silently — see below for what that
cost us.

The version is the filename prefix and the name is the rest of it, so
`20260255000000_youtube.sql` is version `20260255000000`, name `youtube`.

## Verifying production against the repo

The repo can build its own database from scratch, which makes it possible to
check production against what the migrations actually say:

```bash
./scripts/test-db.sh          # builds crm_test from every migration in order
```

Then compare the two schemas — tables and columns, then functions, triggers,
policies, indexes, enums and check constraints. A per-table fingerprint is
enough to find the tables worth looking at closely:

```sql
select c.table_name || '|' || count(*) || '|' ||
       md5(string_agg(c.column_name||':'||c.data_type||':'||c.is_nullable,
                      ',' order by c.column_name))
from information_schema.columns c
join information_schema.tables t
  on t.table_schema = c.table_schema
 and t.table_name = c.table_name
 and t.table_type = 'BASE TABLE'
where c.table_schema = 'public'
group by c.table_name
order by c.table_name;
```

Run it on both and diff. One caveat: `pgcrypto` lives in `public` on a local
Postgres and in `extensions` on Supabase, so its 22 functions show as a
difference and are not one.

## The 2026-08 reconciliation

Production and the repo had drifted, in both directions at once.

The ledger held 20 rows against the repo's 68, and not one version matched.
The recorded rows carried timestamp versions and hand-written names —
`bulk_update_records`, `rls_initplan_part1`, `campaigns_revoke_anon` — while
the repo numbers its files in a synthetic sequence. Twelve were the same
migration under a different name; eight named no repo file at all. The other
48 migrations had been applied by pasting SQL, so nothing recorded them.

A full structural comparison found the schemas otherwise identical: 45 tables
with matching columns, types and nullability, and matching counts of triggers
(52), policies (109), indexes (168), enums (15) and check constraints (406).

One real difference. `contacts.specialty_market` and `contacts.customer_type`
still existed in production. `20260202000000_company_cards.sql` moves both
facts to the company and then drops the contact columns, but the drop sits
inside an `if exists` block that never ran here. Both columns were empty across
all 98 contacts, written by no form and read by no screen — the contact page
reads these values from the joined company, which is the design that migration
established. The same block was re-run as written; the roll-up moved nothing
and the columns are gone.

With the schemas equal, the ledger was replaced with the 68 repo versions.

The 20 rows it held before, kept here because they are the only record that
they existed:

```
20260812190929  bulk_update_records
20260812223238  mailable_override
20260812223324  campaigns_and_outbox
20260812223431  campaigns_revoke_anon
20260812223445  campaigns_revoke_public
20260812231650  campaign_audience_from_ids
20260813004746  campaign_link_clicks
20260813031227  product_detail_and_pricing
20260813031250  products_sync_active_search_path
20260813200622  deal_history
20260813201917  deal_ledger
20260813205147  deal_stage_history
20260813211304  deal_custom_fields
20260814135651  lock_down_function_grants
20260814135823  rls_initplan_part1
20260814135915  rls_initplan_part2
20260814140036  revoke_trigger_function_grants
20260814141422  organization_timezone
20260819010909  field_options_case_insensitive
20260819012008  security_advisories_countries_rls_and_trigger_grant
```
