# Setting up Gmail logging, step by step

A click-by-click runbook for turning the mailbox sync on. `docs/SYNC.md`
explains how the thing works and why; this explains what to press.

Steps 1–5 are done — the values below are what is actually configured, kept
here so the setup can be verified, audited or rebuilt. Steps 6–11 are the
remaining deployment work.

---

## One project, every account

FLO Ventures owns **one** Google Cloud project and **one** OAuth app for the
whole CRM. The accounts inside the CRM — AFM Global Trading, FLO Ventures Inc.,
and whatever comes next — are *not* separate projects. Each person connects
their own mailbox as a test user of this single app, and
`mailbox_connections.organization_id` plus row-level security keeps one
account's mail invisible to another's.

| | |
|---|---|
| Project | **FLO CRM** |
| Project ID | `flo-crm-505116` — permanent, appears in API errors and audit logs |
| Owner | `info@flo-ventures.com` (Workspace org `flo-ventures.com`) |
| OAuth app name | **FLO CRM** — the name users read in *"FLO CRM wants access…"* |
| Mode | External, kept in **Testing** |
| Client | **FLO CRM Web**, `1066008960139-mkvc7e4pu88fod7h8pbvicenv4qs9g3k.apps.googleusercontent.com` |
| Domain | `https://crm.flo-ventures.com` |

The earlier `afm-crm-505115` project and its client ID were a first draft,
never wired up, and are discarded. Deleting it is optional.

The project is owned by the FLO Ventures account on purpose. It is shared
infrastructure that every account's sync depends on, so it does not live inside
any one account's Google account — including AFM's.

**Cost: nothing.** The Gmail API has no paid tier and needs no billing account.
The free allowance is a billion quota units a day; polling one mailbox costs a
few hundred at most. If a screen asks for a card, you are in the wrong product.

---

## Step 1 — The project *(done)*

Created while signed in as `info@flo-ventures.com`, named **FLO CRM**, with the
project ID `flo-crm-505116` set at creation — the only moment a project ID can
be chosen, and it can never be changed afterwards.

To verify: <https://console.cloud.google.com> → the project picker should show
*FLO CRM*, and the account chip should read `info@flo-ventures.com`. Almost
every confusing error later comes from configuring one project and pasting
credentials from another.

## Step 2 — Gmail API *(done)*

Enabled at <https://console.cloud.google.com/apis/library/gmail.googleapis.com>
(**APIs & Services → Library**, search *Gmail API*).

Skip this and everything else still configures cleanly — you only find out when
the first sync returns 403.

## Step 3 — Consent screen *(done)*

This is the screen users see when they click Connect Gmail, and where the
personal-Gmail decision actually gets made.

Google renamed this area recently. New console: **Google Auth Platform**, at
<https://console.cloud.google.com/auth/overview>, with *Branding*, *Audience*,
*Data access* and *Clients* down the left. Older console: **APIs & Services →
OAuth consent screen**, as one wizard. Same fields either way.

### 3a. Branding

- **App name:** `FLO CRM` — the master app's name, not any one account's. It is
  the name in *"FLO CRM wants access to your Google Account"*, seen by every
  user of every account.
- **User support email** and **developer contact:** `info@flo-ventures.com`

Logo, homepage and privacy-policy links are left empty. They only matter if you
later go for verification.

### 3b. Audience

**External**, publishing status left at **Testing**.

*Publish app* looks like the finishing move and is the one thing that would
break this. Gmail's read scope is *restricted*, so publishing puts the app into
Google's verification queue: a review, a demo video, a privacy policy, and an
annual third-party security assessment (CASA) that runs into thousands of
dollars a year. Testing needs none of it.

The trade for staying in Testing:

| | Testing | Published |
|---|---|---|
| Personal `@gmail.com` | works | works |
| Domains you don't own | works | works |
| Users | 100, each listed by hand | unlimited |
| Refresh tokens | expire after **7 days** | do not expire |
| Google's review | none | required |

Testing is the only configuration that accepts both personal Gmail addresses
and domains FLO does not own, which is what a portfolio CRM needs. The
seven-day expiry is the whole cost, and it costs each person one click a week.
The CRM is built for it: the mailbox shows *Needs reconnecting* with a button,
and reconnecting resumes from where it stopped rather than re-reading the
backfill window.

### 3c. Data access (scopes)

Exactly two, and neither can send, delete or relabel mail:

- `https://www.googleapis.com/auth/gmail.readonly` — flagged **Restricted**,
  which is expected and is not a problem in Testing.
- `https://www.googleapis.com/auth/userinfo.email` — how the CRM learns which
  mailbox was just connected, so it can label the connection.

Nothing wider. `gmail.modify`, or `https://mail.google.com/`, would let the CRM
delete somebody's mail, and no code path here would ever use it.

To add or check them: **Data access → Add or remove scopes**, then paste each
into the filter box — it is the only sane way through the list.

## Step 4 — Test users *(done, ongoing)*

**Audience → Test users**. Currently listed:

- `tradingafm@gmail.com`

Add every further address as accounts onboard — personal `@gmail.com`, your
domain, a client's domain, it makes no difference here.

**An address that is not on this list cannot sign in at all.** They get
*"Access blocked: FLO CRM has not completed the Google verification process"*
and no way past it. This is the most common setup failure by a wide margin, and
it looks exactly like a broken app rather than a missing list entry.

The cap is **100, shared across every account in the CRM** — not 100 each. When
you approach it, that is the signal to weigh publishing the app (verification
plus the annual assessment) or moving to per-account projects. Don't build
either yet; `mailbox_connections` is already keyed by organization, so
per-account credentials would be an additive change.

## Step 5 — OAuth client *(done)*

**Clients → FLO CRM Web**, type **Web application**.

- Client ID: `1066008960139-mkvc7e4pu88fod7h8pbvicenv4qs9g3k.apps.googleusercontent.com`
- Client secret: held outside this repository. Not written here, not in git,
  not in chat.
- Authorised redirect URIs:

  ```
  https://crm.flo-ventures.com/api/gmail/callback
  http://localhost:3000/api/gmail/callback
  ```

- Authorised JavaScript origins: empty. This flow never runs in the browser.

The redirect URIs must match what the app sends **character for character** —
scheme, host, port, path, no trailing slash. `https://` against `http://`, or a
`www.` present on one side only, produces `redirect_uri_mismatch` and nothing
more helpful.

Preview deployments get a fresh URL each time and therefore cannot match a
registered URI. Gmail connect works on production and localhost only; that is
inherent to OAuth, not worth working around.

## Step 6 — Generate the two secrets

```bash
openssl rand -base64 32   # → MAILBOX_TOKEN_KEY
openssl rand -hex 32      # → SYNC_INGEST_SECRET
```

`MAILBOX_TOKEN_KEY` encrypts every stored refresh token (AES-256-GCM) and must
decode to exactly 32 bytes, which is what `-base64 32` gives. Two things follow:
**losing it means every mailbox must be reconnected**, and **leaking it is
equivalent to leaking the tokens themselves**. Keep a copy somewhere that is
neither this repository nor a chat window.

`SYNC_INGEST_SECRET` is the bearer token the scheduler presents to the poller.

These two, and the Google client secret, go straight from your terminal or the
console into Vercel. They should never be pasted into a conversation, echoed
into a log, or committed — including to a file that is gitignored today and
might not be tomorrow.

## Step 7 — Set the environment variables

In Vercel: **Project → Settings → Environment Variables**, scope *Production*
(and *Preview* if you want the rest of the app working there — Gmail connect
will not, see step 5).

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | `1066008960139-mkvc7e4pu88fod7h8pbvicenv4qs9g3k.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | from the OAuth client page |
| `MAILBOX_TOKEN_KEY` | from step 6 |
| `SYNC_INGEST_SECRET` | from step 6 |
| `NEXT_PUBLIC_SITE_URL` | `https://crm.flo-ventures.com` — no trailing slash |

`NEXT_PUBLIC_SITE_URL` is what the app builds the redirect URI from, so it has
to agree with step 5 exactly. Unset, it falls back to Vercel's per-deployment
URL, which changes on every deploy and will therefore never match.

It is not only the Gmail redirect: `src/app/(app)/settings/actions.ts` builds
invitation links from it too. So the same domain must also be listed in
**Supabase → Authentication → URL Configuration → Redirect URLs**, as
`https://crm.flo-ventures.com/auth/callback`, or invitations will send people to
the wrong host.

Before any of this works, `crm.flo-ventures.com` must actually be serving the
app: **Vercel → Settings → Domains**, with DNS pointed at Vercel.

**Redeploy afterwards.** Environment variables apply to deployments made after
they are set, not to the one already running.

Locally, the same values go in `.env.local` (gitignored) with
`NEXT_PUBLIC_SITE_URL=http://localhost:3000`.

## Step 8 — Apply the migration

The connections table ships as
`supabase/migrations/20260207000000_mailbox_connections.sql`.

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or paste that one file into the Supabase SQL editor if the earlier migrations
are already applied. It refuses to run out of order — if `current_app_user_id()`
does not exist yet it stops with a message saying to run the earlier migrations
first, rather than half-creating things.

Reload **Settings → Mailboxes**. The "Gmail sync is not configured" notice
should be gone, with a **Connect Gmail** button in its place. If the notice is
still there, the env vars did not reach the running deployment — go back and
redeploy.

## Step 9 — Schedule the poller

Nothing syncs without this. The endpoint is `/api/gmail/sync` and it wants
`Authorization: Bearer <SYNC_INGEST_SECRET>`.

**On Vercel Pro:** `vercel.json` already registers it every 10 minutes. Set
`CRON_SECRET` in the environment variables — Vercel sends it automatically as
the bearer token, and the route accepts either that or `SYNC_INGEST_SECRET`.

**On Vercel Hobby:** scheduled functions run at most **once a day**, which is
not a sync anybody believes in. Drive it from Supabase instead — **Database →
Extensions**, enable `pg_cron` and `pg_net`, then in the SQL editor:

```sql
select cron.schedule('gmail-sync', '*/10 * * * *', $$
  select net.http_post(
    url     := 'https://crm.flo-ventures.com/api/gmail/sync',
    headers := '{"Authorization": "Bearer <SYNC_INGEST_SECRET>"}'::jsonb
  );
$$);
```

Check on it later with `select * from cron.job;` and
`select * from cron.job_run_details order by start_time desc limit 10;`.

Either way, prove it works by hand first:

```bash
curl -X POST https://crm.flo-ventures.com/api/gmail/sync \
  -H "Authorization: Bearer $SYNC_INGEST_SECRET"
```

`{"connections":0,"results":[]}` is the correct answer before anyone has
connected a mailbox. `401` means the secret does not match; `503` means the
environment variables are missing from the running deployment.

## Step 10 — Connect the first mailbox

As a CRM user whose address is on the test-user list:

1. **Settings → Mailboxes** → **Connect Gmail**.
2. Choose the Google account. This is the mailbox that gets logged, so someone
   signed into several accounts should read this screen rather than click
   through it.
3. **"Google hasn't verified this app"** appears. This is Testing mode showing,
   not a fault. **Advanced** → **Go to FLO CRM (unsafe)**. Worth telling people
   in advance, because it reads alarmingly and the natural response is to back
   out.
4. Grant the read-only permissions. The screen will say the app wants to *read*
   your email — there is no send or delete in the list, because those scopes
   were never requested.
5. You land back on Mailboxes with the address listed and *backfilling 30 days*.

The first sync happens on the next scheduled run, not instantly. Trigger the
curl from step 9 if you would rather not wait.

## Step 11 — Confirm it worked

Open a contact you have emailed in the last 30 days. The email should be on
their timeline, quoted chain stripped.

Nothing there? Work through it in this order:

1. Is the mailbox showing a **Last synced** time on the Mailboxes page? If not,
   the scheduler is not running — step 9.
2. Does that contact's email address in the CRM match the address on the
   message? Matching is by address; a contact stored with a different one will
   never match.
3. Was the message more than 30 days old? Widen the window with the backfill
   control on the Mailboxes page (admins only), then run the sync again.
4. Is there a message in amber under the mailbox? That is the last error the
   poller recorded, verbatim.

---

## When something goes wrong

| What you see | What it means | Fix |
|---|---|---|
| *Access blocked: FLO CRM has not completed the Google verification process* | The address is not a test user | Add it in step 4. Also check they are connecting the account you listed |
| `redirect_uri_mismatch` | The URI the app sent is not registered | Compare `NEXT_PUBLIC_SITE_URL` + `/api/gmail/callback` against the console entry, character for character |
| *Google hasn't verified this app* | Normal in Testing | Advanced → Go to FLO CRM |
| CRM says **Gmail sync is not configured** | Env vars missing from the running deployment | Step 7, then redeploy |
| CRM says **Google did not return a refresh token** | Google only issues one on a first grant, and this account has granted before | Remove *FLO CRM* at <https://myaccount.google.com/permissions>, then connect again |
| CRM says *That link expired or did not come from here* | The state cookie expired (10 minutes) or the flow was resumed in a different browser | Start again from the Mailboxes page |
| Sync returns 403, *Gmail API has not been used in project…* | Step 2 was skipped, or was done in a different project | Enable the Gmail API in `flo-crm-505116` |
| Mailbox reads **Needs reconnecting** | Usually the seven-day expiry; also a revoked grant or a password change | Click Reconnect. Weekly is expected |
| Poller returns 401 | Bearer token mismatch | The scheduler's secret must equal `SYNC_INGEST_SECRET` or `CRON_SECRET` |

## Adding someone later

1. Add their address to **Test users** in the Google console (step 4).
2. They sign in to the CRM and connect their own mailbox (step 10).

That is the whole of it — no new project, no new client, no config change, no
redeploy, whichever account they belong to.

## The weekly reconnect, in practice

Every seven days each connected mailbox flips to *Needs reconnecting* and stops
collecting mail until somebody clicks the button. Nothing already logged is
lost, and syncing resumes from where it stopped rather than re-reading the
backfill window.

Two ways out, whenever they become worth it, and neither requires touching the
code:

- **Publish the app** and complete Google's verification and CASA assessment.
  Removes the expiry and the 100-user cap; costs money annually.
- **Put everyone in the flo-ventures.com Workspace** and switch the consent
  screen to Internal. Removes the expiry for free, but Internal only accepts
  addresses in domains FLO owns — which rules out personal Gmail, and so rules
  out AFM as currently set up.
