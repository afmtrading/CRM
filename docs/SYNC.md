# Mailbox and calendar sync (PRD 6.4)

> **Status:** the CRM half is built and tested. The Google-side connector is
> not — it needs Google Cloud credentials and an OAuth consent screen that do
> not exist yet. This document is the specification for whoever builds it.

The acceptance criterion is:

> An email sent from a synced Gmail account to a Contact's email address appears
> on that Contact's timeline within a defined sync interval, without manual
> logging.

That splits into two halves. The CRM half decides *which contact a message
belongs to and what the timeline entry says*. The connector half *gets the
messages out of Google*. They are separated on purpose: the matching rules are
pure functions with unit tests (`src/lib/sync.ts`, `tests/sync.test.ts`), and
swapping Gmail for Outlook later means writing a second connector, not touching
the CRM.

## What is built

### `POST /api/activities/ingest`

Authenticated with a bearer token (`SYNC_INGEST_SECRET`), not a user session,
because a background job has no session.

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

Response:

```json
{ "logged": 1, "duplicates": 0, "unmatched": 0 }
```

Behaviour:

- **Contact matching** — every address on the message except the mailbox
  owner's own is matched against contacts *in the named organization only*.
  A message involving two known contacts produces one timeline entry each.
- **Attribution** — the activity's owner is the CRM user whose email matches
  `mailboxAddress`, so it appears as that person's work.
- **Idempotency** — `(organization_id, external_source, external_id)` is unique
  and the write is an upsert. Re-delivering the same message, or overlapping
  poll windows, cannot create duplicates. Re-sending is always safe.
- **Unmatched messages are dropped**, not stored. Personal email does not end
  up in the CRM.
- Calendar events use `"type": "meeting"` with `attendees` instead of
  `to`/`cc`, and land as meeting activities.
- The endpoint returns **503** when `SYNC_INGEST_SECRET` is unset, so it is off
  until deliberately configured.

## What the connector has to do

1. **OAuth.** Register a Google Cloud project, enable the Gmail and Calendar
   APIs, and run the consent flow per user with the read-only scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/calendar.readonly`

2. **Store the tokens.** Refresh tokens are credentials for someone's mailbox —
   they belong in a table with RLS as strict as everything else, or in a secret
   store, never in `custom_fields` or anywhere the app reads casually. A
   `mailbox_connections` table (organization_id, user_id, provider, refresh
   token, `last_synced_at`, `history_id`) is the natural shape and follows the
   same tenancy rules as the rest of the schema.

3. **Poll on a schedule.** A Vercel Cron job every 5–15 minutes is enough for
   "within a defined sync interval". Use Gmail's `historyId` for incremental
   fetches rather than re-listing the mailbox, and Calendar's `syncToken`
   likewise.

4. **Post to `/api/activities/ingest`.** Batch up to 500 messages per call.
   Because ingestion is idempotent, the connector can re-post a window it is
   unsure about instead of tracking exactly-once delivery itself.

5. **Handle revocation.** A revoked or expired refresh token should disable the
   connection and surface in the UI rather than retrying silently forever.

### Two-way sync

PRD 6.4 says "two-way". Inbound (Google → CRM) is what the endpoint above
covers, and it is the half the acceptance criterion tests. Outbound (composing
an email from the CRM and having it appear in the rep's Gmail Sent folder) needs
the `gmail.send` scope and a compose UI; it is worth confirming with Flo whether
that is actually wanted in Phase 1, since reps typically prefer to send from
Gmail itself and simply have it logged.
