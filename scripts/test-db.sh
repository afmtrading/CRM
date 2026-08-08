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

echo
echo "All database tests passed."
