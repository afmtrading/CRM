# FLO CRM

One CRM application, one codebase, one deployment, run by every company in the
FLO Ventures portfolio. Each organization's data is completely walled off from
every other organization's; a feature built once is live for all of them.

Built on Next.js (App Router) + Supabase (Postgres, Auth, RLS), deployed on
Vercel. Implements **Phase 1 (MVP)** of the CRM PRD.

---

## Quick start

```bash
npm install
cp .env.example .env.local        # fill in your Supabase project's values
npm run dev                       # http://localhost:3000
```

### 1. Create the Supabase project

Create a project at [supabase.com](https://supabase.com), then copy the URL and
keys from **Project Settings → API** into `.env.local`.

### 2. Apply the schema

With the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or paste each file in `supabase/migrations/` into the SQL editor, in filename
order. The migrations create the schema, the RLS policies, the business-logic
functions, and the two starting organizations (AFM Global Trading and FLO
Ventures Inc.), each with a default pipeline and stages.

### 3. Create the first administrator

Organizations and users are provisioned internally — there is no public signup
(PRD 1.3). Create the first admin by hand, in the SQL editor:

```sql
insert into users (organization_id, email, name, role, status)
values (
  (select id from organizations where slug = 'afm-global-trading'),
  'you@yourcompany.com',
  'Your Name',
  'admin',
  'invited'
);
```

Then sign in at `/login` with that email address. The `on_auth_user_created`
trigger links the Supabase Auth account to this record on first sign-in and
flips it to `active`. From then on, admins invite everyone else from
**Settings → Users**.

---

## What's here

| PRD section | Feature | Where |
|---|---|---|
| 2, 10 | Tenant isolation, two independent layers | `supabase/migrations/*_rls.sql`, `src/lib/tenancy.ts` |
| 6.1 | Auth, session bound to one organization | `src/lib/tenancy.ts`, `middleware.ts`, `src/app/login` |
| 6.2 | Contacts, companies, custom fields, duplicate detection, merge | `src/app/(app)/contacts`, `src/app/(app)/companies` |
| 6.3 | Pipelines, stages, deals, kanban + list views | `src/app/(app)/deals` |
| 6.4 | Activity logging, tasks, reminders, mailbox/calendar ingestion | `src/app/(app)/activities`, `src/app/api/activities/ingest` |
| 6.5 | Lead capture, rule-based scoring, assignment routing | `src/app/(app)/settings/lead-scoring`, `.../assignment` |
| 6.6 | Filtering, grouping, saved views | `src/lib/filters.ts`, `src/components/filter-bar.tsx` |
| 6.7 | CSV import with mapping + preview, export, deduplication | `src/app/(app)/settings/import`, `src/app/api/export` |
| 6.8 | Pipeline value report, by stage and by owner | `src/app/(app)/reports/pipeline-value` |
| 9 | REST endpoints beyond plain CRUD | `src/app/api/**` |

### API

Plain CRUD goes through Supabase's auto-generated PostgREST API. The endpoints
that need real logic are built here:

| Endpoint | Purpose |
|---|---|
| `POST /api/contacts/{id}/merge` | Merge a duplicate into this contact, reassigning its deals and activities |
| `POST /api/imports` | Run an import; returns the job with per-row results |
| `GET /api/imports/{id}` | Poll an import job's status and per-row errors |
| `POST /api/contacts/score/recalculate` | Re-run lead scoring rules over existing contacts |
| `GET /api/reports/pipeline-value` | Pipeline value, filterable by pipeline, stage and owner |
| `GET /api/export?entity=contact` | CSV export of any filtered view (`entity=all` for a full JSON backup) |
| `POST /api/activities/ingest` | Mailbox/calendar connector drop-off point (see `docs/SYNC.md`) |

Every one of these resolves the caller's organization before it touches data.

---

## Tenancy

This is the architectural commitment the whole system rests on, so it is
enforced twice, independently:

1. **Application layer** — `scoped(context, table)` in `src/lib/tenancy.ts` is
   the only sanctioned way to reach a tenant table. It applies the
   `organization_id` filter before handing back the query builder, so a caller
   cannot forget it.
2. **Database layer** — every table has RLS enabled and `FORCE`d, with policies
   scoped to `public.current_org_id()`. If application code ever has a bug, the
   database still refuses to return another organization's rows.

The service-role key bypasses RLS and is used in exactly two places: sending
user invitations, and the sync ingestion endpoint. Both check authorisation
themselves and scope every query explicitly.

---

## Testing

```bash
npm run verify     # typecheck + lint + unit tests + production build
npm run test       # unit tests only (filters, CSV mapping, sync matching)
npm run test:db    # migrations + tenant isolation + business rules, against Postgres
```

`npm run test:db` needs a reachable Postgres (`PGHOST`/`PGPORT`/`PGUSER`, or a
running `supabase start`). It drops and recreates a `crm_test` database, applies
every migration, and then runs:

- **`supabase/tests/01_tenant_isolation.sql`** — the test PRD Section 10 calls
  for. Signs in as a real user in Organization A and confirms that reading,
  searching, fetching by known id, updating, deleting, inserting into, and
  reporting on Organization B's data all fail. Then does the mirror image as a
  user in Organization B, and checks that disabled users, unauthenticated
  sessions, and forged organization claims all see nothing.
- **`supabase/tests/02_business_rules.sql`** — the Phase 1 acceptance criteria
  that live in the database: stage-default probability and the manual-override
  exception, lead scoring, duplicate detection and merge, pipeline value
  matching a manual sum, and assignment routing.

---

## Deploying to Vercel

1. Connect the GitHub repository to a Vercel project.
2. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SITE_URL` in the project's
   environment variables.
3. In Supabase, add the Vercel deployment URLs to
   **Authentication → URL Configuration → Redirect URLs**, including preview
   deployments (`https://*-your-team.vercel.app/auth/callback`).

Every branch then gets its own preview deployment, which is what makes the
Vercel Comments review workflow in PRD Section 13.2 work.

---

## Project layout

```
src/
  app/
    (app)/              authenticated application, one folder per feature
    api/                REST endpoints beyond plain CRUD
    login/, auth/       sign-in and the auth callback
  components/           shared UI (filter bar, activity timeline, primitives)
  lib/
    tenancy.ts          session context + the organization-scoped query builder
    filters.ts          filter/group/saved-view engine (pure)
    csv.ts              import mapping and CSV serialisation (pure)
    sync.ts             mailbox/calendar matching rules (pure)
    supabase/           client construction for server, browser and middleware
supabase/
  migrations/           schema, RLS, functions, seed
  tests/                SQL test suites
scripts/test-db.sh      database test runner
tests/                  unit tests
docs/SYNC.md            what the Gmail/Calendar connector has to do
```

---

## Known gap

**Gmail and Calendar sync (PRD 6.4) is half-built.** The CRM side is done and
tested: `POST /api/activities/ingest` accepts messages and events, matches them
to contacts by email address within one organization, and writes them onto the
timeline idempotently. The Google-side connector — OAuth consent, token
storage, and the scheduled poll — is **not** built, because it needs Google
Cloud credentials and an OAuth consent screen that do not exist yet.
`docs/SYNC.md` specifies exactly what that connector has to do. Everything else
in Phase 1 is implemented.
