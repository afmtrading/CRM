# Production data changes

Changes made directly to production data, outside the migrations and outside the
app. Migrations are the record of what the schema allows; this is the record of
what was done to the rows, which nothing else captures — a `field_options` row
added by hand and one added through Settings → Fields are indistinguishable
afterwards.

Append an entry per change. Say what moved, how many rows, and how to put it
back. A change that cannot be reversed from the entry alone needs its list of
ids written down here before it is made, not after: once a value is merged into
another, the rows that held it are indistinguishable from the rows that always
had it.

Contact names are deliberately left out. An id is what a revert needs, and this
file is permanent in a way a person's name in git history should not be.

---

## 2026-08-21 — `SO-` renumbered to `PO-`

Organization: AFM CRM (`whsoqglssercfruxomaf`).

Context: the section is called Purchase orders, and the number on the document
was the last place still saying Sales order. Applied as part of migration
`20260265000000_purchase_order_numbers.sql` rather than by hand, and recorded
here because it rewrites a column on rows that have already been sent to
customers.

Net effect:

- 5 sales orders renumbered, `SO-0001` … `SO-0005` becoming `PO-0001` …
  `PO-0005`. Only the prefix moved, so each organization's sequence is unbroken
  and a number stays recognisable to anybody holding a copy.
- No other column touched, and no rows created or deleted.

**Why the generator had to change in the same migration.** `next_document_number`
takes the prefix as `p_kind` and also uses it to decide which table to count —
`where ... and p_kind = 'SO'` is a constant predicate, not a row filter. Asking
it for a `PO` number against the old definition returns an empty scan, a
maximum of zero, and `PO-0001` every time. Verified before and after against a
throwaway Postgres: before the rename the next bare number was `PO-0001`, which
would have collided with the rewritten `SO-0001`; after it, `PO-0004` and
`PO-Acme-0002`.

### Reverting

The prefix is the only thing that moved, so the inverse is exact. These are the
five rows, read out of production before the change was made:

| id | was | is |
| --- | --- | --- |
| `1b92ff8c-65fc-4063-ad6b-8dd378db3798` | SO-0001 | PO-0001 |
| `ba1726c3-b957-4848-a6eb-a6b9cc00bed5` | SO-0002 | PO-0002 |
| `68addbf4-315e-4e5d-b2db-9ea582a3fdb0` | SO-0003 | PO-0003 |
| `eba7f846-d182-4fb6-9f7b-484f68f15035` | SO-0004 | PO-0004 |
| `f3755466-96c4-4257-afbe-0fcf0f0da2c5` | SO-0005 | PO-0005 |

```sql
update sales_orders set number = 'SO-' || substring(number from 4)
where id in (
  '1b92ff8c-65fc-4063-ad6b-8dd378db3798',
  'ba1726c3-b957-4848-a6eb-a6b9cc00bed5',
  '68addbf4-315e-4e5d-b2db-9ea582a3fdb0',
  'eba7f846-d182-4fb6-9f7b-484f68f15035',
  'f3755466-96c4-4257-afbe-0fcf0f0da2c5'
);
```

`create_sales_order` would also need to pass `'SO'` again — the definition
before this change is in `20260242000000_default_currency.sql`.

---

## 2026-08-20 — `Standard` consolidated into `Medium`

Organization: AFM CRM (`e4739794-7ce0-41c5-a2a8-b6819cd3dc92`).

Context: the first production run of `supabase/checks/data-integrity.sql` found
15 records on a priority of `Standard` that no option list contained (#121).
`Standard` was added to the three priority lists to stop the select silently
discarding it, then consolidated into `Medium` and removed again.

Net effect:

- 14 companies and 1 contact moved from `priority = 'Standard'` to `'Medium'`.
- The `Standard` option was removed from the contact, company and product
  priority lists, and the ordering gap closed, so the lists are back to their
  original four values and original numbering.
- Companies on `Medium` went 0 → 14. Contacts on `Medium` went 1 → 2.

### Reverting

These are the rows that held `Standard`. The one contact already on `Medium`
before the merge is not in this list, which is the whole reason the list exists.

```sql
update companies set priority = 'Standard' where id in (
  '4515eb22-d2c9-4bf0-bed5-f9f01240ac67',  -- CFAO Healthcare
  '9f650da0-1d19-4e8a-a680-0977fe0f7f7a',  -- Coastal Export Inc
  '4c482d3c-9fd2-4c23-881c-261851ee9ce0',  -- Direct Textile Store
  'da5dfb05-c888-4a44-a2c6-ae2c1ee06bd9',  -- National Scrubs
  'ff13e585-6f5f-415d-901a-4c57e65ea679',  -- Peripap
  '588c78a2-6b5e-43b3-ba79-f6f6806b37de',  -- Ropasusada.com (Pacinca)
  '041e9aee-c880-4e47-b67e-9f5d52390cda',  -- Scrub Authority
  'bdd1ba2c-e562-4d47-ac9c-43bc79cde0b1',  -- SK Export (UAE)
  '3053565e-8434-450a-a670-ddff6ba037f5',  -- Tex-Fab (Ballots de vetements)
  '5b23b50c-20b8-46b6-8d87-837204e0b88b',  -- The Uniform Outlet
  '5c76b634-4941-4005-a2f3-29f201e93a5d',  -- Top Down Trading Ltd
  'e9cff90d-38c6-4d1a-930b-96a8cc19e8fc',  -- Via Trading
  '6bca49f7-af9c-43da-bf8c-d9c5295f8c5f',  -- Wholesale Scrub Sets
  '14f6386b-8d86-4418-a418-41f658b566f8'   -- WholesaleScrubs.com
);

update contacts set priority = 'Standard'
where id = '9011887a-0cb6-499c-9523-70ecf2e9e929';
```

Reverting the records also means putting the option back, or the values orphan
again. Add `Standard` to each priority list — contact at order 2, company and
product at order 3, shifting the rows at and after it up by one — or add it
through Settings → Fields and drag it below `Medium`.

## 2026-08-20 — two option values added, one corrected

Same organization, same run.

- `Influencer` added to the contact `role_type` list, at the vacant order 2 and
  in cyan to match every other value in that list. Revert: delete it.
- Grocery Outlet (`5bfcc24b-2f86-4b5b-87eb-bee7b2f99051`) had its `stock_type`
  corrected from `CloseOut` to `CLOSEOUTS`, the value the list actually holds —
  a different word rather than a different casing, so the case-insensitive match
  did not absorb it. Revert: `array_replace` back.

Neither is destructive: the first adds a row, the second changes one element of
a one-element array on a single company.

## 2026-08-20 — nine company domains filled in

Organization: AFM CRM (`e4739794-7ce0-41c5-a2a8-b6819cd3dc92`).

Context: the Digital card on a contact showed "Company website —" for a
contact at GovDeals, whose `domain` was empty. Eleven of 178 live companies had
no domain; the other 167 did, so the card's fallback was working and these were
a data gap rather than a bug.

Every value is the corporate email domain of contacts at that company, not a
guess from the name. `https://` prefixes match the dominant existing format.

```sql
-- companies.domain, set where it was previously null
59a45e01-58bd-41b6-998f-c498a5393f4b  B-Stock                              https://bstock.com
6f89343f-66ed-4b5c-a53c-7e4d4d67eef6  B-Stock Solutions                    https://bstock.com
2289d3e3-7f49-451b-8bb8-ba0e5b6716a5  Direct Auctions                      https://directliquidation.ca
b83310dd-9eee-4965-a87b-8fb520095bcd  Direct Auctions / Direct Liquidation https://directliquidation.ca
0cd8eeaf-2695-431e-8df1-6c4a7c3af3a8  Direct Liquidation                   https://directliquidation.ca
8425275d-c3ce-43c6-a4f8-f79caf6abaa7  GovDeals.ca / GovDeals.com           https://govdeals.com
c3c23529-1ee8-4c97-9496-1e9d395d4e4d  Hilco Global                         https://hilcoglobal.com
922fa08a-51a3-4504-95b5-b179056af20f  MaxSold                              https://maxsold.com
36d4fd2d-7a27-4329-8a1f-eeebe0c50e54  McDougall Auctioneers                https://mcdougallauction.com
```

Reverting means setting `domain` back to null for those ids. Coverage went from
167/178 to 176/178.

### The two left empty, and why

`bibi` and `Yoyo`. Their only contacts use gmail.com, and a personal address
says nothing about a company's website — writing `gmail.com` into a domain
field would point every visitor at Gmail, which is worse than the dash. These
need somebody who knows the business.

### One judgement call

McDougall Auctioneers' four contacts split exactly two and two between
`mcdauction.com` and `mcdougallauction.com`. Nothing in the data breaks the
tie, so the one matching the company's name was taken. If the other is the real
site it is a one-line change.

### Noticed while checking the format, not fixed

One company holds `acme@acme.com` in `domain` — an email address in a column
that is read as a URL, so `safeUrl` renders it as a `mailto:` link where a
website should be.


## 2026-08-21 — a fixed "Discount" becomes money off, not a new price

`revised_rate_type = 'fixed'` meant the rate *replaced* the unit price, while
`'percent'` meant a reduction — two meanings under one column labelled
Discount. Entering `$1` against a $6 unit therefore made the unit $1, not $5.
The desk asked for the reading the label implies: money off each unit.

`sales_line_discount()` changes with it, so every stored total computed under
the old reading is now wrong by the definition the database itself holds. The
two lines that used a fixed rate are restated. Read out of production before
the change:

```sql
-- sales_order_lines, before
-- id                                    order     qty  unit    rate   discount  line_total
   298b0094-422a-464c-8941-650157c5036e  PO-0006   1    100.00  10.00  90.00     10.00
   a216b823-5100-4a68-9e08-80fcb922ace3  PO-0007   2      6.00   1.00  10.00      2.00

-- after, under "money off each unit"
   298b0094-422a-464c-8941-650157c5036e  PO-0006   1    100.00  10.00  10.00     90.00
   a216b823-5100-4a68-9e08-80fcb922ace3  PO-0007   2      6.00   1.00   2.00     10.00
```

Both orders are worth more than they were, because a line that read "$10"
against a $100 unit was charging $10 for it rather than taking $10 off.

Neither has been invoiced — checked before the change, `invoice_lines` joined
through `invoices.sales_order_id` returns nothing for either — so no issued
document is restated by this. Percentage lines are untouched: their meaning
never changed.

Reverting means restoring `fixed` to a replacement price in
`sales_line_discount()` and in `revisedUnitPrice` in `src/lib/sales.ts`, then
touching those two rows to recompute. The values above are what they held.


## 2026-08-21 — `PO-` goes back to `SO-`

The section was renamed Purchase orders, and then back to Sales orders. The
number prefix followed it out and follows it back: half a book reading `PO-`
and half `SO-` is worse than either, which is the same reason the first rename
moved them at all.

These seven were `SO-` originally, became `PO-` under 20260265000000 this
afternoon, and return to what they were. Read out of production before the
change, while they still said `PO-`:

```sql
-- sales_orders.number, before → after
1b92ff8c-65fc-4063-ad6b-8dd378db3798  PO-0001 → SO-0001
ba1726c3-b957-4848-a6eb-a6b9cc00bed5  PO-0002 → SO-0002
68addbf4-315e-4e5d-b2db-9ea582a3fdb0  PO-0003 → SO-0003
eba7f846-d182-4fb6-9f7b-484f68f15035  PO-0004 → SO-0004
f3755466-96c4-4257-afbe-0fcf0f0da2c5  PO-0005 → SO-0005
20550646-89cb-48e2-9894-619b90f5beb8  PO-0006 → SO-0006
5afd65b3-4d65-4a64-898b-f78ba6d9d300  PO-0007 → SO-0007
```

Only the prefix moves, so each organization's sequence is unbroken and the
numbers stay recognisable — and for anybody who saw them before this afternoon,
they are the numbers they always were.

`next_document_number` already accepts either name for the orders sequence, so
only `create_sales_order` changes back. Invoices are untouched: they were never
renamed, and `INV-` has meant one thing throughout.

Reverting means swapping the two strings, which is what 20260265000000 did in
the other direction.


## 2026-08-22 — one order marked Invoiced because its invoice exists

Invoiced stops being something anybody can set by hand. An order reaches it
when `convert_sales_order_to_invoice` raises the invoice, and not otherwise —
so the status now means "there is an invoice", which is what the desk read it
as all along.

That leaves one row disagreeing with the new rule. Read out of production
before the change:

```sql
-- sales_orders, orders that have an invoice
SO-0007  status = confirmed   invoice INV-0003   → fulfilled
SO-0008  status = fulfilled   invoice INV-0004   → unchanged
```

SO-0007 was invoiced in fact and not in status, which is the gap this closes
from the other side. Nothing was marked Invoiced *without* an invoice, so no
row is being demoted and no status is being taken away from anybody.

Worth knowing rather than discovering: `isEditable` is false for this status,
so SO-0007's lines are frozen from now on. That was already true of SO-0008
and is the point of the status — an order somebody has billed for is not one
to keep editing.

Reverting means setting SO-0007 back to `confirmed`; the rule itself reverts
by restoring `fulfilled` to nextStatuses and dropping the trigger.

## 2026-08-22 — Discount and shipping columns added

`20260271000000_document_discount.sql` adds `discount_type` and `discount_rate`
to `sales_orders` and `invoices`. Both nullable, both left null on every
existing row: no order and no invoice is retroactively discounted, and the
stored totals are untouched because `document_discount` returns zero for a null
pair.

Nothing is destroyed here. The one behaviour that changes for existing rows is
the `invoices_total` trigger's column list, which now also fires on the two new
columns — an invoice whose discount is edited recomputes its stored total,
which it could not do before because the columns did not exist.

Verified before applying, against a throwaway Postgres running every migration
in order:

- `select count(*) from sales_orders where discount_rate is not null` → 0
- `select count(*) from invoices where discount_rate is not null` → 0
- every stored `invoices.total` equal to `subtotal + shipping_charge`, as before

## 2026-08-22 — document_history added

`20260272000000_document_history.sql` creates `document_history` and puts an
AFTER INSERT OR UPDATE trigger on `sales_orders` and `invoices`. Nothing
existing is altered or destroyed: no column changes, no value is rewritten.

The one write against existing data is the backfill — one `created` row per
sales order and per invoice, marked `source = 'backfill'`, stamped with the
document's own `created_at` and `created_by`. It asserts only "this existed by
then". The changes those documents went through before this table existed were
never recorded and are not invented.

Counted before applying, on production:

- 12 sales orders, 6 invoices → 18 backfill rows expected
- `document_history` did not previously exist, so no rows could be overwritten

The table grants INSERT to nobody and has no update or delete policy, so the
definer trigger is the only writer. Verified in `19_sales_orders.sql`: a
manager's hand-written insert, update and delete are all refused.

## 2026-08-22 — invoices and invoice_lines gain columns

`20260273000000_an_invoice_on_its_own.sql`.

`invoices` gains five nullable shipping columns; `invoice_lines` gains `unit`,
`revised_rate_type` and `revised_rate`. All nullable, all null on every existing
row. No stored money is recomputed: `discount` and `line_total` are untouched
everywhere.

The one write against existing data is the rate backfill on `invoice_lines`.
For a line with a discount, `sales_line_discount` for a fixed rate is
quantity × rate, so a stored discount D over Q units came from a rate of D/Q.
It is written **only where it round-trips to the cent** — the update carries its
own `sales_line_discount(...) = discount` guard, so a line that would come back
a penny different keeps no rate at all rather than one that quietly restates it.
Percent is not recoverable and is not invented; those lines come back as the
equivalent money off each unit, which prices identically.

Counted on production before applying:

- 12 invoice lines, 11 with a discount, all 11 with quantity > 0
- every `invoices.total` equal to `subtotal - discount + shipping_charge`

`add_invoice_line` is dropped and recreated rather than replaced: a new
parameter is a new signature, and `create or replace` leaves the old function
standing beside it. The SQL suite caught that as "function is not unique".
