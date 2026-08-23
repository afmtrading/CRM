# Marketing forms

A form is the only way somebody who is not in the CRM gets into it.

Everything else that creates a contact — typing one in, importing a CSV,
matching one out of a mailbox — moves a person who is already known into the
database. A form is the front door, and it closes four gaps at once:

- **Capture.** A stranger becomes a contact without anybody retyping them. The
  lead-scoring rules and the assignment rules fire on the way in, so the lead
  arrives scored and owned.
- **Consent.** `contacts.marketing_consent` has always distinguished express
  consent — "they actively agreed: a form, a tick box, a signature" — from
  implied, and campaigns refuse to send without one. Until forms existed there
  was no way to *create* express consent, only to assert it afterwards on
  somebody's word. A submission is the artefact that proves it.
- **Attribution.** `utm_*`, the referring page and the form's own source, kept
  at the only moment they are knowable.
- **Follow-up.** The owner is told, and the contact can go straight onto a
  mailing list.

## The pieces

| Where | What |
|---|---|
| `/forms` | The list, and where a new one is made |
| `/forms/{id}` | The builder: questions, consent, routing, sharing, submissions |
| `/f/{slug}` | The public page — no session, framable on purpose |
| `marketing_forms` | The form and its settings |
| `marketing_form_submissions` | What was actually submitted, kept verbatim |
| `marketing_form_public(slug)` | The published form's public half. `anon` may execute it |
| `submit_marketing_form(...)` | The whole capture, in one transaction. `anon` may execute it |

Those two functions are the entire anonymous surface. `anon` holds no grant on
either table.

## Questions, and what they fill

Each question either fills one named column on the contact or stays on the
submission. The list of columns it may fill is short and closed:

    full_name  first_name  last_name  email  phone
    job_title  company_name  website  notes  custom_fields.*

Nothing else. A form that could write any column is a form a stranger could use
to set `owner_id`, `lead_score` or `lifecycle_stage` — those are decided by the
form's own settings or by a rule. The whitelist is enforced by a trigger on
`marketing_forms`, so both the renderer and the submit path sit behind it.

A form cannot be published without a question that fills `email`: without one it
collects answers that can never become a contact, which is the failure that
looks like success.

## Consent

The form's `consent_basis` decides what a submission creates:

- **express** — a tick box is shown, in words you write. Ticking it is what
  makes the consent express, so it is never pre-ticked. The exact wording is
  copied onto every submission, so changing it later does not rewrite what
  somebody agreed to.
- **implied** — no tick box. Asking for a quote *is* the business relationship.
  Expires after two years, like any implied consent.
- **none** — no marketing consent at all. Right for a support or careers form.

`consent_required` is off by default, and that matters: agreeing to a newsletter
and asking for a price are two different acts, and forcing them together is what
makes the consent indefensible. Turn it on for a form whose whole purpose is the
opt-in.

### An unsubscribe outranks a tick box

If the address has unsubscribed, or is on the suppression list, a new opt-in
changes nothing. The submission is kept and flagged (`consent_conflict`), and
the form's screen says so. A fresh express opt-in is genuinely a valid new
consent — but a form can be filled in by somebody other than its subject, and
silently resurrecting an unsubscribe is the one mistake in this area that turns
into a complaint rather than a correction. A person decides.

## The same person twice

A submission matching an existing contact by email updates blank fields only. A
returning visitor typing "Bob" must not overwrite the "Robert Nkemelu, VP
Procurement" a rep corrected last week — the form is one input among several and
not the authoritative one. What they typed is kept verbatim on the submission
either way.

Consent is the exception: a newer, stronger basis does replace an older one, and
the submission is its evidence.

## Putting it on a website

The builder hands out a link and an `<iframe>` snippet. An iframe rather than a
script tag, deliberately: a script that injects markup inherits the host page's
CSS and breaks differently on every site it is pasted into, needs CORS on the
submit path, and asks a customer to run our JavaScript on their page.

`/f/{slug}` therefore sets `Content-Security-Policy: frame-ancestors *` — the
one route in the app that is meant to be framed. There is nothing to steal by
framing it: no session, no authenticated action.

Add `?embed=1` (the snippet does) and the page drops its outer chrome so it
sits inside the host design instead of arguing with it.

One useful side effect of the iframe: the `Referer` on the request that renders
it is the customer's own page, which is otherwise unreachable across origins.
That is what lands in `page_url`.

## Addresses

Slugs are unique across the whole installation, because `/f/{slug}` carries no
tenant. New forms get a short random suffix for that reason — without one the
first account to claim `contact-us` would hold it against everybody else. It is
only a default; edit it to anything still free.

## Spam

A honeypot field, and nothing else. There is deliberately no "submitted too
fast" trap: that check fires on somebody using autofill on a two-field form, and
silently discarding a real lead costs more than the spam it stops.

## Tests

`supabase/tests/31_marketing_forms.sql`, run by `npm run test:db`. The pure
logic — slugs, question keys, publication rules — is in `tests/forms.test.ts`.
