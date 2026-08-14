# Permissions in FLO CRM

How the system decides what a person can do, and how to change it.

Last updated for migrations `20260235000000` – `20260237000000`.

---

## The short version

1. **Permissions live in sets, not in roles.** A *permission set* is a named list
   of capabilities — "sees every record", "may delete", "may reach Settings".
   People are on a set, and the set decides.
2. **You edit them on screen.** Settings → Permissions. Ticking a box changes
   what the database allows, immediately, for everybody on that set.
3. **The database enforces it, not the interface.** An unticked box is refused
   by the server. Hiding a button is not what stops anybody.

---

## How a person's permissions are decided

Three steps, in order. The first one that answers, wins.

| | |
|---|---|
| **1. Their own set** | If somebody has been put on a set directly (Settings → Users → Permissions column), that set decides and their role is ignored entirely. |
| **2. Their role's set** | Otherwise, the set matching their role. Everybody starts here — five sets are created for every organization, one per role. |
| **3. The old rule** | If neither resolves — an organization somehow missing its sets — the system falls back to the hardcoded rule each role had before sets existed. This is a safety net that should never fire. It exists so that a missing set can never lock an administrator out of the screen they would need to fix it. |

**"See hidden records" is the exception.** It has no fallback. Before it
existed nothing could be hidden, so the honest degraded answer is *no* — a
fallback would show hidden records to every administrator the moment something
went wrong.

---

## The capabilities

### Which records they see

Not a checkbox — a choice of three:

| Option | What it means |
|---|---|
| **Every record in the organization** | Everything, regardless of who owns it. |
| **Their own, plus anything unassigned** | Their own records, plus any record with no owner. Unassigned records stay visible on purpose: assignment routing can leave a record ownerless, and a lead nobody can see is a lead that gets lost. |
| **Only their own** | Their own records and nothing else. |

### The seven checkboxes

| Capability | What it actually controls |
|---|---|
| **Create and edit** | Add contacts, companies, deals and activities, and change them. |
| **Delete** | Delete records. They go to the recycle bin, not away. |
| **Manage shared records** | Products, campaigns, tags, stock locations — the things the whole desk shares rather than one person's records. Also setting who owns a record. |
| **Import, export and bulk edit** | Change many records at once, and take data out of the system. |
| **Settings and the recycle bin** | Pipelines, users, fields, mailboxes, email sending, and restoring deleted records. |
| **See hidden records** | Contacts and companies somebody has hidden — and the ability to hide and unhide them. |
| **Manage permissions** | Edit these sets and decide who is on them. |

---

## Why some capabilities are deliberately separate

### "Manage permissions" is not implied by "Settings"

If everyone who could reach Settings could also edit the sets, they could tick
their own boxes — and every other restriction would be advisory. You cannot
meaningfully withhold *Delete* from somebody who can tick *Delete*.

So they are two boxes. You can give somebody the run of Settings — pipelines,
fields, users — without giving them the ability to rewrite the rules.

This is not a new restriction. An administrator could always change anybody's
role, which is the same power by a different route. What is new is being able
to take it away.

### "See hidden records" is one box, not two

The obvious split is "may see hidden records" and "may hide records". It is the
wrong split.

Somebody who could hide but not see would hide the wrong contact, watch it
vanish from their own screen, and have no way to find it again, confirm it
still exists, or put it back. That is not hiding — it is an accidental delete
with no undo.

So it is one box, and it grants both. Anybody who can hide something can always
find it again.

---

## The five starting sets

Every organization is created with these. They match exactly what the five
roles could do before permission sets existed — so nothing changed on the day
they arrived.

| | Administrator | Manager | Sales director | Sales rep | Read-only |
|---|:---:|:---:|:---:|:---:|:---:|
| **Sees** | everything | everything | own + unassigned | own only | own + unassigned |
| Create and edit | ● | ● | ● | ● | — |
| Delete | ● | ● | ● | ● | — |
| Manage shared records | ● | ● | — | — | — |
| Import, export, bulk edit | ● | ● | ● | — | — |
| Settings and recycle bin | ● | — | — | — | — |
| See hidden records | ● | — | — | — | — |
| Manage permissions | ● | — | — | — | — |

**Read-only sees unassigned records but a sales rep does not.** That is
inherited from the original role definitions, not a decision made when sets
were introduced. Change it if it is wrong for you — that is what the screen is
for.

---

## Changing things

### Editing a set

**Settings → Permissions.** Change the name, the visibility dropdown, the
checkboxes. Save. It applies to everybody on that set immediately.

The headcount beside each set name tells you how many people it affects before
you touch anything — and it counts people who land on the set through their
role, not only people assigned to it directly.

### Putting somebody on a set

**Settings → Users → Permissions column.** Choose a set and press Set.

From that moment their role stops deciding for them. Their role stays on the
record — it is still shown, and it is what they fall back to if you put them
back on "Role default" — but it no longer controls anything.

### Creating a set

**Settings → Permissions → New permission set.** A new set grants **nothing**
until you tick something. That is deliberate: on a screen where the boxes are
the point, the safe starting position is off.

---

## What the system will refuse

Four guards. All four are enforced in the database, so none of them can be
worked around.

| It refuses | Why |
|---|---|
| **Leaving nobody who can reach Settings** | Settings would be gone, along with the screen you would need to fix it. |
| **Leaving nobody who can manage permissions** | The rules could never be edited again — including by you, if you were the one who did it. The message says so. |
| **Deleting a set somebody is on** | The people on it would silently drop to different permissions with no sign anything had happened. Move them first; the message tells you how many there are. |
| **Two sets with the same name** | Case-insensitive, within one organization. |

The first two are checked **after** the change, in the same transaction — so a
refusal takes the change with it and nothing is left half-applied.

Note that you *are* allowed to remove your own access, as long as somebody else
still has it. The guard is about the organization ending up with nobody, not
about any particular person keeping anything.

---

## Hidden contacts and companies

A hidden record is out of sight for everybody without **See hidden records** —
including the person who owns it, and including managers who otherwise see
every record in the organization.

**To hide one:** open the contact or company and press **Hide**. To hide many,
use bulk edit — `hidden` is a bulk-editable field.

**It is not a delete.** The record is whole. Unhide puts it straight back.

### What hiding does

- Removes it from lists, searches, counts and direct lookups
- Removes it from campaign audiences — a hidden contact is not emailed
- Stops it generating birthday reminders
- Records who hid it and when

### What hiding does *not* do

- **It does not hide the record's deals, activities, invoices or sales
  orders.** A deal on a hidden contact stays visible with the contact name
  unreadable. The identity is gone; the existence is not.
- **Hiding a company does not hide its contacts.** Those are separate flags.
  Hide them too if they should be.

---

## Setting up a simpler two-set arrangement

If five sets is more than you need, this is all screen work — no migration, no
developer.

1. **Settings → Permissions** — rename *Administrator* to **Master Admin**, and
   *Sales rep* to **Regular User**. Adjust the checkboxes on each until they say
   what you want.
2. **Settings → Users** — move anybody currently on Manager, Sales director or
   Read-only onto one of the two.
3. **Settings → Permissions** — delete the three now-empty sets.

Step 3 will refuse while anybody is still on a set, and tell you how many, so
the steps cannot be done in the wrong order.

---

## Where this is enforced

Every capability above is checked by the database, in roughly a hundred
row-level security policies, not by the application.

That distinction matters. A button that is not shown is a convenience; a
request that is refused is a rule. If the interface and the database ever
disagree, the database wins and the person sees a failure rather than a breach.

This means:

- Editing a permission set changes what the **server** allows, not just what
  the screen offers.
- There is no URL to type, no request to craft, and no export to run that gets
  around an unticked box.
- Somebody who signs in with their own credentials and queries the database
  directly gets exactly the same answers.

---

## For the record: the underlying names

If you are ever reading the database or a migration, the screen labels map to
these columns on `permission_sets`:

| Screen | Column |
|---|---|
| Every record in the organization | `see_all_records` |
| Their own, plus anything unassigned | `see_unassigned` |
| Create and edit | `write_records` |
| Delete | `delete_records` |
| Manage shared records | `manage_records` |
| Import, export and bulk edit | `bulk_records` |
| Settings and the recycle bin | `administer` |
| See hidden records | `see_hidden` |
| Manage permissions | `manage_permissions` |

A person's own set is `users.permission_set_id`; when it is null, the set whose
`role` matches `users.role` answers instead.
