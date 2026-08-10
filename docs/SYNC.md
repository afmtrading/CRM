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

**[docs/GMAIL_SETUP.md](GMAIL_SETUP.md) is the click-by-click runbook**, including
what each Google console screen is called, what the users see, and what every
error message means. What follows is the shape of it and the reasoning.

### 1. Google Cloud

**One project for the whole CRM** — `FLO CRM` / `flo-crm-505116`, owned by
`info@flo-ventures.com`. The accounts inside the CRM are not separate projects;
each person connects their own mailbox as a test user of this one app, and
`organization_id` plus RLS keeps one account's mail away from another's. The
project is deliberately not inside any single account's Google account, since
every account's sync depends on it.

The Gmail API enabled, an **External** consent screen left in **Testing**, the
two scopes below, every user's address on the test-user list, and a Web
application client whose redirect URIs are
`https://crm.flo-ventures.com/api/gmail/callback` and the localhost equivalent.

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
    url     := 'https://crm.flo-ventures.com/api/gmail/sync',
    headers := '{"Authorization": "Bearer <SYNC_INGEST_SECRET>"}'::jsonb
  );
$$);
```

Or by hand, to test:

```
curl -X POST https://crm.flo-ventures.com/api/gmail/sync \
  -H "Authorization: Bearer $SYNC_INGEST_SECRET"
```

### 4. Connect a mailbox

Each person goes to **Mailboxes** (in the account menu, and in Settings for
admins) and clicks Connect Gmail. They connect their own mailbox and nobody
else's — the callback reads the user from the session, never from the request.

Their address must be on the test-user list first, or Google refuses the sign-in
before the CRM is involved. Google will also warn that the app is unverified;
**Advanced → Go to FLO CRM** continues past it. Both are worth saying in
advance, because each one looks like the app is broken.

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
  answers 404 afterwards. Silently stopping would look exactly like "no new
  mail", so the connection re-anchors and reopens the walk instead.
- **A new connection anchors forwards immediately.** The mailbox's current
  cursor is read at the start of the run, so a mailbox is watching for new mail
  from its very first poll rather than after its archive has finished
  importing.
- **A dead grant stops the connection.** `invalid_grant` — revoked, password
  changed, or the seven-day testing-mode expiry — marks it `needs_reauth` and
  surfaces on the Mailboxes page with a Reconnect button, rather than failing
  quietly every ten minutes for a year.
- **Reconnecting resumes, it does not restart.** `needs_reauth` keeps the
  cursor and the callback carries it across, so the weekly reconnect picks up
  where the mailbox stopped instead of re-scanning the backfill window every
  week. A cursor that has genuinely aged out still falls back to a backfill on
  the next run, so keeping it can only save work.
- **Ceilings per run:** 75 messages per mailbox, 25 mailboxes.
- **The ceiling is enforced beside the cursor, not after it.** `listHistory`
  takes the limit and returns a cursor covering exactly the ids it returned,
  stopping on a history-record boundary. The two cannot disagree, so an
  incremental backlog genuinely drains over successive runs instead of being
  skipped. Gmail may re-deliver the boundary record; that costs nothing,
  because ingestion is idempotent.
- **The history import walks backwards, over as many runs as it takes.**
  `backfill_until` records how far back it has reached; each run takes another
  chunk of whatever budget the incremental path did not use and moves it
  earlier. A year of archive therefore imports without one heroic request, and
  without delaying this morning's email — the two cursors are independent, and
  new mail always gets first call on the budget.
- **The walk finishes by reaching the window edge**, not by setting a flag. So
  widening the window on the Mailboxes page starts it moving again by itself,
  with no disconnect and reconnect.
- **A chunk is skipped below ten messages.** The walk moves its cursor to the
  oldest message it fetched, and Gmail may hand that same message back if it
  treats `before:` as inclusive. A boundary that cannot move is a walk that
  never ends.
- **The cursor comes from Gmail's timestamps, not the parsed messages.** A chunk
  of nothing but drafts and spam parses to nothing at all, and a cursor derived
  from what survived parsing would stall on that window forever.
- **An expired history cursor reopens the walk.** Mail from the gap is no longer
  reachable incrementally, so the connection re-anchors forwards and re-walks
  the window. Re-ingesting is free; missing mail is not.

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
