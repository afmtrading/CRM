# Setting up Gmail logging, step by step

A click-by-click runbook for turning the mailbox sync on. `docs/SYNC.md`
explains how the thing works and why; this explains what to press.

Allow about 30 minutes for the first time through. Steps 1–5 are done once by
one person; steps 6–9 are deployment; step 10 is each user, and takes them
under a minute.

---

## Before you start

You need:

- The Google account **tradingafm@gmail.com**, signed in.
- Admin access to the Vercel project and the Supabase project.
- The production domain the CRM is served from.

**Cost: nothing.** The Gmail API has no paid tier and needs no billing account
attached to the project. The free allowance is a billion quota units a day; a
poll of one mailbox costs a few hundred at most. You will not be asked for a
card at any point, and if a screen does ask for one you have wandered into the
wrong product.

---

## Step 1 — Create the Google Cloud project

1. Go to <https://console.cloud.google.com> and confirm the account chip in the
   top right reads **tradingafm@gmail.com**. If it does not, switch account
   before doing anything else — a project created under the wrong account is
   easier to recreate than to move.
2. Click the project picker in the top bar (it says *Select a project*, or
   shows whichever project you last opened) → **New project**.
3. Name: `FLO CRM`. Leave **Location** as *No organisation* — a personal Gmail
   account has no organisation, and that is expected.
4. **Create**, then wait for the notification bell to say it is ready and use
   the picker again to make sure `FLO CRM` is the *selected* project. Almost
   every confusing error later comes from configuring a different project than
   the one whose credentials you eventually paste into Vercel.

## Step 2 — Enable the Gmail API

1. Open <https://console.cloud.google.com/apis/library/gmail.googleapis.com>
   (or **APIs & Services → Library** and search for *Gmail API*).
2. Check the project name at the top is `FLO CRM`.
3. Click **Enable**. It takes a few seconds.

If you skip this, everything else still configures cleanly and the first sync
fails with a 403 saying the API is disabled for the project.

## Step 3 — Configure the consent screen

This is the screen your users see when they click Connect Gmail, and the place
where the personal-Gmail decision actually gets made.

Google renamed this area recently. New console: **Google Auth Platform**, at
<https://console.cloud.google.com/auth/overview>, with *Branding*, *Audience*,
*Data access* and *Clients* down the left. Older console: **APIs & Services →
OAuth consent screen**, as one wizard. Same fields either way.

### 3a. Branding

- **App name:** `FLO CRM` — this is the name in the sentence *"FLO CRM wants
  access to your Google Account"*, so make it something your team recognises.
- **User support email:** `tradingafm@gmail.com`
- **Developer contact information:** `tradingafm@gmail.com`

Logo, homepage and privacy-policy links are optional while the app is in
testing. Leave them empty; filling them in is only worthwhile if you later go
for verification.

### 3b. Audience

- Choose **External**.
- **Leave the publishing status as *Testing*.** Do not press *Publish app*.

That button looks like the finishing move and is the one thing that will break
this. Gmail's read scope is *restricted*, so publishing puts the app into
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

The seven-day expiry is the whole cost, and it costs each person one click a
week. The CRM is built for it: the mailbox shows *Needs reconnecting* with a
button, and reconnecting resumes from where it stopped rather than re-reading
the backfill window.

### 3c. Data access (scopes)

Click **Add or remove scopes**. The list is long and the filter box is the only
sane way through it — paste each of these in turn and tick the result:

- `https://www.googleapis.com/auth/gmail.readonly` — listed under Gmail API and
  flagged **Restricted**. That flag is expected and is not a problem in
  Testing.
- `https://www.googleapis.com/auth/userinfo.email` — this is how the CRM learns
  which mailbox was just connected, so it can label the connection.

**Update**, then **Save**. Nothing else. Anything wider — `gmail.modify`, or
`https://mail.google.com/` — would let the CRM delete somebody's mail, and the
code has no path that would ever use it.

## Step 4 — Add the test users

Still on **Audience**, find **Test users** → **Add users**.

Add every address that will connect a mailbox: personal `@gmail.com`, your work
domain, a client's domain, it makes no difference here. One per line, up to 100.

**An address that is not on this list cannot sign in at all.** They get
*"Access blocked: FLO CRM has not completed the Google verification process"*
and no way past it. This is the single most common setup failure, and it looks
exactly like a broken app rather than a missing list entry.

Add yourself first, so there is something to test with in step 10.

## Step 5 — Create the OAuth client

1. **Clients** (new console) or **APIs & Services → Credentials** (old) →
   **Create client** / **Create credentials → OAuth client ID**.
2. **Application type: Web application.** Not Desktop — a desktop client cannot
   use the redirect URIs below.
3. Name: `FLO CRM web` (internal only, nobody sees it).
4. **Authorised redirect URIs** → **Add URI**, twice:

   ```
   https://your-production-domain/api/gmail/callback
   http://localhost:3000/api/gmail/callback
   ```

   Substitute your real domain in the first. These must match what the app
   sends **character for character** — scheme, host, port, path, no trailing
   slash. `https://` vs `http://`, or `www.` present on one side and absent on
   the other, produces `redirect_uri_mismatch` and nothing else.

   Leave *Authorised JavaScript origins* empty; this flow never runs in the
   browser.
5. **Create.** Copy the **Client ID** and **Client secret** from the dialog.

The secret can be re-read from the client's page afterwards, so losing the
dialog is not a disaster.

## Step 6 — Generate the two secrets

```bash
openssl rand -base64 32   # → MAILBOX_TOKEN_KEY
openssl rand -hex 32      # → SYNC_INGEST_SECRET
```

`MAILBOX_TOKEN_KEY` encrypts every stored refresh token (AES-256-GCM) and must
decode to exactly 32 bytes, which is what `-base64 32` gives you. Two things
follow: **losing it means every mailbox must be reconnected**, and **leaking it
is equivalent to leaking the tokens themselves**. Keep a copy somewhere that is
not the repository and not a chat message.

`SYNC_INGEST_SECRET` is the bearer token the scheduler presents to the poller.

## Step 7 — Set the environment variables

In Vercel: **Project → Settings → Environment Variables**. Add to *Production*
(and *Preview*, if you want the sync working there too):

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 5 |
| `GOOGLE_CLIENT_SECRET` | from step 5 |
| `MAILBOX_TOKEN_KEY` | from step 6 |
| `SYNC_INGEST_SECRET` | from step 6 |
| `NEXT_PUBLIC_SITE_URL` | `https://your-production-domain` — no trailing slash |

`NEXT_PUBLIC_SITE_URL` is what the app builds the redirect URI from, so it has
to agree with step 5 exactly. If it is unset, the app falls back to Vercel's
per-deployment URL, which changes on every deploy and will therefore never
match a registered redirect URI.

**Redeploy afterwards.** Environment variables apply to deployments made after
they are set, not to the one already running.

Locally, the same values go in `.env.local` with
`NEXT_PUBLIC_SITE_URL=http://localhost:3000`.

## Step 8 — Apply the migration

The connections table ships as `supabase/migrations/20260207000000_mailbox_connections.sql`.

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or paste that one file into the Supabase SQL editor if the earlier migrations
are already applied. It refuses to run out of order — if `current_app_user_id()`
does not exist yet it stops with a message saying to run the earlier migrations
first, rather than half-creating things.

Reload **Settings → Mailboxes**. The "Gmail sync is not configured" notice
should be gone and a **Connect Gmail** button in its place. If the notice is
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
    url     := 'https://your-domain/api/gmail/sync',
    headers := '{"Authorization": "Bearer <SYNC_INGEST_SECRET>"}'::jsonb
  );
$$);
```

Check on it later with `select * from cron.job;` and
`select * from cron.job_run_details order by start_time desc limit 10;`.

Either way, prove it works by hand first:

```bash
curl -X POST https://your-domain/api/gmail/sync \
  -H "Authorization: Bearer $SYNC_INGEST_SECRET"
```

`{"connections":0,"results":[]}` is the correct answer before anyone has
connected a mailbox. `401` means the secret does not match; `503` means the
environment variables are missing from the running deployment.

## Step 10 — Connect the first mailbox

As a CRM user whose address you added in step 4:

1. **Settings → Mailboxes** → **Connect Gmail**.
2. Choose the Google account. This is the mailbox that gets logged, so someone
   signed into several accounts should read this screen rather than click
   through it.
3. **"Google hasn't verified this app"** appears. This is the Testing mode
   showing, not a fault. **Advanced** → **Go to FLO CRM (unsafe)**. Worth
   telling your team in advance, because it reads alarmingly and the natural
   response is to back out.
4. Grant the read-only permissions. The screen will say the app wants to *read*
   your email — there is no send or delete in the list, because those scopes
   were never requested.
5. You land back on Mailboxes with the address listed and *backfilling 30 days*.

The first sync happens on the next scheduled run, not instantly. Trigger the
curl from step 9 if you would rather not wait.

## Step 11 — Confirm it worked

Open a contact who you have emailed in the last 30 days. The email should be on
their timeline, quoted chain stripped.

Nothing there? Work through it in this order:

1. Is the mailbox showing a **Last synced** time on the Mailboxes page? If not,
   the scheduler is not running — step 9.
2. Does that contact's email address in the CRM actually match the address on
   the message? Matching is by address; a contact stored with a different one
   will never match.
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
| Sync returns 403, *Gmail API has not been used in project…* | Step 2 was skipped, or was done in a different project | Enable the Gmail API in the project the client ID belongs to |
| Mailbox reads **Needs reconnecting** | Usually the seven-day expiry; also a revoked grant or a password change | Click Reconnect. Weekly is expected |
| Poller returns 401 | Bearer token mismatch | The scheduler's secret must equal `SYNC_INGEST_SECRET` or `CRON_SECRET` |

## Adding someone later

1. Add their address to **Test users** in the Google console (step 4).
2. They sign in to the CRM and connect their own mailbox (step 10).

That is the whole of it — no new client, no config change, no redeploy. Above
100 test users you would have to publish the app and take on verification, so
if the team is heading that way it is worth knowing early.

## The weekly reconnect, in practice

Every seven days each connected mailbox flips to *Needs reconnecting* and stops
collecting mail until somebody clicks the button. Nothing already logged is
lost, and syncing resumes from where it stopped rather than re-reading the
backfill window.

Two ways out, whenever they become worth it, and neither requires touching the
code:

- **Publish the app** and complete Google's verification and CASA assessment.
  Removes the expiry and the 100-user cap; costs money annually.
- **Put everyone in one Google Workspace** and switch the consent screen to
  Internal. Removes the expiry for free, but Internal only accepts addresses in
  domains you own — no personal Gmail, and no domains belonging to anyone else.
