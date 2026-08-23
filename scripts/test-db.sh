#!/usr/bin/env bash
#
# Runs the migrations and the tenant-isolation tests against a throwaway
# Postgres database.
#
#   ./scripts/test-db.sh
#
# Requires a reachable Postgres (PGHOST/PGPORT/PGUSER, or a running
# `supabase start`). The database named below is dropped and recreated on every
# run, so never point this at anything you care about.

set -euo pipefail

DB="${CRM_TEST_DB:-crm_test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

psql -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists ${DB};" >/dev/null
psql -q -v ON_ERROR_STOP=1 -d postgres -c "create database ${DB};" >/dev/null

echo "→ bootstrapping Supabase-provided objects"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/00_bootstrap.sql"

for migration in "${ROOT}"/supabase/migrations/*.sql; do
  echo "→ $(basename "${migration}")"
  psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${migration}"
done

echo "→ tenant isolation tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/01_tenant_isolation.sql"

echo "→ business logic tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/02_business_rules.sql"

echo "→ contact card tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/03_contact_cards.sql"

echo "→ company card tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/04_company_cards.sql"

echo "→ role and ownership tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/05_roles.sql"

echo "→ sales tier and soft delete tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/06_soft_delete.sql"

echo "→ product tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/07_products.sql"

echo "→ mailbox connection tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/08_mailboxes.sql"

echo "→ stage ordering tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/09_stage_ordering.sql"

echo "→ pipeline ordering and deal notes tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/10_pipeline_ordering.sql"

echo "→ company rating card tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/11_company_rating_card.sql"

echo "→ bulk update tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/12_bulk_update.sql"

echo "→ marketing consent tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/13_marketing_consent.sql"

echo "→ campaign and outbox tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/14_campaigns.sql"

echo "→ stock tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/15_stock.sql"

echo "→ deal history tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/16_deal_history.sql"

echo "→ deal ledger tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/17_deal_ledger.sql"

echo "→ stage history tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/18_stage_history.sql"

echo "→ sales order and invoice tests"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/19_sales_orders.sql"

echo "→ retiring pipelines and stages"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/20_retire_pipelines.sql"

echo "→ permission sets"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/21_permission_sets.sql"

echo "→ editing permission sets"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/22_manage_permission_sets.sql"

echo "→ hidden contacts and companies"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/23_hidden_records.sql"

echo "→ geography and territories"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/24_geography.sql"

echo "→ import profiles"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/25_import_profiles.sql"

echo "→ bulk delete"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/26_bulk_delete.sql"

echo "→ default currency"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/27_default_currency.sql"

echo "→ stock notes"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/28_stock_level_notes.sql"

echo "→ column preferences"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/29_column_preferences.sql"

echo "→ marketplaces"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/30_marketplaces.sql"

echo "→ marketing forms"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${ROOT}/supabase/tests/31_marketing_forms.sql"

echo
echo "All database tests passed."
