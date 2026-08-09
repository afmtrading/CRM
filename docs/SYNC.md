# Mailbox sync (PRD 6.4)

> **Status:** built and tested, off until configured. Logging only — emails
> written in Gmail appear on the contact's timeline in the CRM. Nothing is ever
> sent from the CRM.

The acceptance criterion is:

> An email sent from a synced Gmail account to a Contact's email address appears
> on that Contact's timeline within a defined sync interval, without manual
> logging.

## How it fits together

```
Gmail  ──►  /api/gmail/sync (poller)  ──►  ingestMessages()  ──►  activities
                                              ▲
external connector ──► POST /api/activities/ingest
```

Two halves, kept apart on purpose. `src/lib/gmail.ts` knows about Gmail and
produces the provider-neutral `IncomingMessage` shape. `src/lib/ingest.ts`
decides which contact a message belongs to and what the timeline entry says,
and knows nothing about Google. Adding Outlook later means writing a second
file, not touching the CRM.

Both the built-in poller and any external connector go through the same
`ingestMessages()`, so the matching and idempotency rules exist once.

## Setting it up

### 1. Google Cloud

Sign in as **tradingafm@gmail.com** — that account owns the project and is the
support address users see on the consent screen.

1. Create a project (`FLO CRM`) and enable the **Gmail API**.
2. OAuth consent screen → **External**, left in **Testing**.
3. Support email and developer contact: `tradingafm@gmail.com`.
4. Add the scopes `gmail.readonly` and `userinfo.email`.
5. Under **Test users**, add every address that will connect a mailbox.
6. Create an OAuth client (Web application) with these redirect URIs:
   - `https://your-domain/api/gmail/callback`
   - `http://localhost:3000/api/gmail/callback`

#### Why External/Testing, and what it costs

Gmail scopes are *restricted*. That leaves three configurations, and only one
of them accepts a personal `@gmail.com` address:

| | Personal Gmail | Outside domains | Reconnects |
|---|---|---|---|
| Internal (Workspace) | no | only domains you own | never |
| External, **Testing** | **yes** | **yes** | every 7 days |
| External, Production | yes | yes | never, but needs Google's verification review plus an annual third-party security assessment |

Testing is chosen because the CRM's users are not all in a domain we control.
The price is that Google expires every refresh token after seven days, so each
person clicks **Reconnect** on the Mailboxes page about once a week. The cap is
100 test users.

Nothing about that is load-bearing on the code: publishing the app later, or
moving everyone into one Workspace and switching to Internal, stops the weekly
reconnects and changes nothing else.

Only two scopes are requested, and neither can send, delete or relabel mail:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/userinfo.email`

### 2. Environment

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MAILBOX_TOKEN_KEY=$(openssl rand -base64 32)
SYNC_INGEST_SECRET=$(openssl rand -hex 32)
```

`MAILBOX_TOKEN_KEY` encrypts stored refresh tokens. Losing it means every
mailbox must be reconnected; leaking it is equivalent to leaking the tokens.

With any of these unset the feature stays off and the Mailboxes page says so.

### 3. Schedule the poller

`vercel.json` already registers it every 10 minutes. Vercel Cron sends
`Authorization: Bearer $CRON_SECRET`, so set `CRON_SECRET` (or reuse
`SYNC_INGEST_SECRET` — both are accepted).

Note that scheduled functions on Vercel's Hobby plan run at most once a day,
which is not a sync anyone believes in. If you are not on Pro, drive it from
Supabase instead:

```sql
select cron.schedule('gmail-sync', '*/10 * * * *', $$
  select net.http_post(
    url     := 'https://your-domain/api/gmail/sync',
    headers := '{"Authorization": "Bearer <SYNC_INGEST_SECRET>"}'::jsonb
  );
$$);
```

Or by hand, to test:

```
curl -X POST https://your-domain/api/gmail/sync \
  -H "Authorization: Bearer $SYNC_INGEST_SECRET"
```

### 4. Connect a mailbox

Each person goes to **Mailboxes** (in the account menu, and in Settings for
admins) and clicks Connect Gmail. They connect their own mailbox and nobody
else's — the callback reads the user from the session, never from the request.

Their address must be on the test-user list first, or Google refuses the sign-in
before the CRM is involved. Google will also warn that the app is unverified;
**Advanced → Go to FLO CRM** continues past it.

About once a week the mailbox will read *Needs reconnecting* — that is the
testing-mode expiry, not a fault. One click on Reconnect and syncing resumes
from where it stopped.

## What is stored, and what is not

- **Only messages involving a contact already in the CRM.** Everything else is
  discarded on arrival and never written. Personal mail does not enter the
  database.
- **Never a deleted contact.** A record in the recycle bin does not quietly
  collect new mail.
- **Quoted reply chains are stripped**, so an entry is what the person wrote
  rather than the whole conversation again.
- **Drafts, chat, spam and binned mail are skipped.**
- Bodies are capped at 20,000 characters.
- A logged email obeys the visibility rules of the contact it is attached to.
  Syncing makes nothing visible to anyone who could not already see the record.

## Credentials

The refresh token is a permanent key to somebody's mailbox. Three things keep
it away from the application:

1. **Encrypted at the application layer** (AES-256-GCM, `src/lib/crypto.ts`)
   with a key held outside the database, so a database backup is ciphertext
   rather than a set of mailbox keys.
2. **No column grant.** `authenticated` holds a column-level `select` grant on
   `mailbox_connections` that deliberately excludes `refresh_token`. A signed-in
   user cannot read a token — not their own, not as an administrator. `select *`
   on that table is *refused*; select the named columns. `supabase/tests/08_mailboxes.sql`
   proves it.
3. **No write grant at all.** Connecting happens in the OAuth callback with the
   service role; disconnecting goes through `disconnect_mailbox()`, which
   destroys the token rather than hiding it.

## Behaviour worth knowing

- **Idempotent.** `(organization_id, external_source, external_id)` is unique and
  the write is an upsert. Overlapping windows, retries and re-runs cannot
  duplicate an entry, which is why the poller re-fetches rather than tracking
  exactly-once delivery.
- **The cursor advances last.** `history_id` is written only after the run's
  messages are stored, so a failure repeats the window instead of skipping it.
- **History expiry is handled.** Gmail keeps roughly a week of history and
  answers 404 afterwards. The poller falls back to a bounded backfill rather
  than stopping — silently stopping looks exactly like "no new mail".
- **A backfill anchors forward.** The mailbox's current cursor is read *before*
  fetching, so after one backfill the connection goes incremental instead of
  backfilling forever.
- **A dead grant stops the connection.** `invalid_grant` — revoked, password
  changed, or the seven-day testing-mode expiry — marks it `needs_reauth` and
  surfaces on the Mailboxes page with a Reconnect button, rather than failing
  quietly every ten minutes for a year.
- **Reconnecting resumes, it does not restart.** `needs_reauth` keeps the
  cursor and the callback carries it across, so the weekly reconnect picks up
  where the mailbox stopped instead of re-scanning the backfill window every
  week. A cursor that has genuinely aged out still falls back to a backfill on
  the next run, so keeping it can only save work.
- **Ceilings per run:** 75 messages per mailbox, 25 mailboxes. A backlog drains
  over successive runs.

## `POST /api/activities/ingest`

Still there, for a connector written outside this app (Outlook, or a separate
process). Authenticated with `SYNC_INGEST_SECRET`.

```http
POST /api/activities/ingest
Authorization: Bearer <SYNC_INGEST_SECRET>
Content-Type: application/json

{
  "organization_slug": "afm-global-trading",
  "messages": [
    {
      "source": "gmail",
      "externalId": "18f2c9a4b7e1",
      "type": "email",
      "subject": "Re: Q3 shipment",
      "body": "Confirming the revised dates…",
      "mailboxAddress": "rep@afmglobal.com",
      "from": "Buyer <buyer@acme.com>",
      "to": ["rep@afmglobal.com"],
      "cc": [],
      "occurredAt": "2026-08-01T14:22:00.000Z"
    }
  ]
}
```

```json
{ "logged": 1, "duplicates": 0, "unmatched": 0 }
```

Calendar events use `"type": "meeting"` with `attendees` instead of `to`/`cc`.
The built-in poller does not fetch calendar events yet; the ingest path for
them exists.

## Not built

**Sending from the CRM.** Composing an email inside the CRM and having it appear
in the rep's Gmail Sent folder needs the `gmail.send` scope, threading headers
(`threadId`, `In-Reply-To`, `References`) and a composer. It was deliberately
left out: logging is what earns its keep on day one, and adding compose later is
additive — nothing here would be thrown away.

**Calendar.** `calendar.readonly` and a second poller. The ingest side already
understands meetings.
