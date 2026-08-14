# Sales orders and invoices

This is the CRM's version of the two documents the Inventory app
(`afmtrading/afm-inventory`) already runs the business on: the **sales order**
and the **invoice**. It was written by reading that app's schema and services
rather than from a description of them, so the money maths, the numbering and
the status machine are the same ones — reconciled against what this CRM
already has.

---

## Sales orders are not deals

**There is no link between a sales order and a deal.** No `deal_id`, no
"convert this deal to an order" button, no status on one that reacts to the
other. Raising a sales order for a company that has never had a deal is the
normal case, not an edge case.

This is worth stating first because linking them is the instinctive thing to
do, and it is expensive to unpick later: every order status change would have
to reason about deal state, every deal report would have to decide whether
order revenue counts, and closing a deal would start to mean two different
things depending on whether somebody had raised an order yet.

They answer different questions and they are kept apart:

| | Deal | Sales order |
| --- | --- | --- |
| Question | *Will we win this?* | *What did they buy?* |
| Lives on | a pipeline, in stages | its own list, by status |
| Ends | won or lost | fulfilled or cancelled |
| Money | a forecast — value × probability | an amount owed |

Both may reference the same company and the same products. That is the only
thing they share.

---

## How it maps onto what the CRM already has

| Inventory app | CRM | Notes |
| --- | --- | --- |
| `Organization` | `organizations` | Same idea; the CRM enforces it with RLS rather than a `where orgId` in every query. |
| `Customer` | `companies` + `contacts` | The CRM already separates the business from the person, so an order carries both: `company_id` is who is billed, `contact_id` is who to call. No new customer table. |
| `CustomerContact` / `CustomerAddress` | `contacts` | Already there, with a primary-contact concept. |
| `Item` | `products` | `sku`, `unit`, `unit_price`, `unit_cost`, `currency` all exist. |
| `Salesperson` (a managed list, separate from users) | `users` | The CRM has real users with roles and an owner concept on every record. A second parallel list of names would be a step backwards, so the order's `owner_id` is a user. |
| `Location` | `stock_locations` | Already exists, with bins. |
| `PaymentMethod` (managed list) | `field_options` | The CRM already has an org-managed option list keyed by field; payment method becomes one more key rather than a new table. |
| `Order` | `sales_orders` | |
| `OrderLine` | `sales_order_lines` | Modelled on `deal_products`, which is already a line-item table with generated totals. |
| `OrderPayment` | `sales_order_payments` | Append-only deposit ledger. |
| `Invoice` | `invoices` | |
| `InvoiceLine` | `invoice_lines` | |
| `InvoicePayment` | `invoice_payments` | |

### What changes to fit

**Currency is per document.** The Inventory app is USD throughout. This CRM is
not — products carry a currency, deals carry a currency, and every total in
reporting is computed per currency and never summed across them. A sales order
and an invoice each carry a currency, and their lines inherit it. Adding two
currencies together is the one arithmetic error this codebase refuses to make
anywhere, and documents are not going to be the exception.

**Unit of measure.** The Inventory app has `UNIT` / `CASE` / `PALLET` with
conversion factors on the item, because it has to pick stock off a shelf. This
CRM sells by the product's own unit — `products.unit` is already free text
("kg", "MT", "container", "licence") — so a line's quantity is in that unit and
there is no conversion. Quantities are `numeric(14,3)` rather than integers for
the same reason: 2.5 MT is a real order line here.

**Ownership and visibility.** The Inventory app shows every order to everybody
with the capability. This CRM has `can_see_owned()` — a sales rep sees their own
records, a manager sees the organization's. Sales orders and invoices follow
the same rule as deals, so the ledger and the order list agree about who can
see what.

**Soft delete.** Deals and products have a recycle bin. Sales orders join them;
an invoice does not — see below.

### What is deliberately left out

- **Pick lists, shipments, backorders, stock allocation.** Warehouse-floor
  work. The Inventory app is where a pallet gets found and moved; the CRM is
  where the sale gets recorded. Duplicating allocation would put two systems in
  charge of the same stock, and the wrong one would win.
- **Stock reservation.** `stock_levels.reserved` exists in this CRM and it is
  tempting to have a signed order fill it. It is left for a second pass on
  purpose: it is the only part of this feature that writes to a number another
  part of the app already owns, and it should land on its own where it can be
  reviewed as a stock change rather than buried in a documents feature.
- **Sales channels** (Shopify, Amazon, eBay, Clover). Nothing here imports
  orders from a marketplace.
- **Order types** (`WHOLESALE` / `SHOWROOM`) as a pricing driver. The CRM has
  no showroom.

---

## The documents

### Sales order

Header: number, company, contact, owner, location, status, currency, order
date, payment terms, shipping charge, notes, terms, signed-at.

Lines: product *or* a free-text description (a one-off line needs no
catalogue entry), notes, quantity, unit price, unit cost, and a **revised
rate** — either a percentage off or a fixed replacement unit price. The dollar
discount and the line total are derived from that, never typed.

**Status**

```
draft ──► reserved ──► confirmed ──► fulfilled
  │           │            │
  └───────────┴────────────┴──────► cancelled
```

- `draft` — being written. Editable, commits to nothing.
- `reserved` — the customer has signed or paid a deposit. In the Inventory app
  this is what holds stock; here it records that the order is real.
- `confirmed` — committed and ready to invoice.
- `fulfilled` — delivered and done.
- `cancelled` — did not happen. Terminal, and a cancelled order cannot take a
  deposit or be invoiced.

The first positive deposit on a draft moves it to `reserved` and stamps
`signed_at`, exactly as the Inventory app does.

### Invoice

An invoice is a **snapshot**. Its lines carry the product's name and SKU as
text, and its subtotal, shipping and total are stored rather than derived. Edit
the sales order afterwards and the invoice does not move — that is the point of
it. Everything else in this codebase derives rather than stores; this is the
one place where storing is correct, because the document was true on the day it
was issued and has to stay true.

An invoice may come from a sales order or be raised on its own. One invoice per
order at most.

**Status** — `draft`, `sent`, `partial`, `paid`, `void`. Only `sent` is set by
hand. `partial` and `paid` are computed from the payment ledger and can never
be typed. `void` is sticky: once void, always void.

**No recycle bin.** A wrong invoice is voided, not deleted — voiding leaves the
number in the sequence, which is what an audit expects. An administrator can
still delete one outright, which frees its order to be invoiced again.

### Payments

Both documents carry an **append-only ledger**. A row is a deposit (positive)
or a reversal (negative); nothing is ever edited or deleted. A reversal that
would take the net below zero is refused.

`invoices.amount_paid` and the invoice's status are maintained by a database
trigger over that ledger and by nothing else — the same "one door" the CRM
already uses for stock levels. There is no code path that can set an invoice to
paid without a payment behind it.

Deposits taken on a sales order are copied onto the invoice when it is
converted, so the balance carries across.

---

## Numbering

- Sales orders: `SO-<Company>-0001`, or `SO-0001` with no company — the
  first word of the company name, stripped to letters and digits. The sequence
  runs per prefix, so each customer's orders count from one.
- Invoices: `INV-0001`, one sequence per organization.

Both are allocated inside the transaction that creates the document, under an
advisory lock keyed to the organization, so two people clicking Save at the
same moment cannot take the same number.

---

## Money

One rule, applied the same way in SQL and in TypeScript:

```
discount   = max(0, quantity × unit_price − quantity × max(0, revised unit price))
line_total = round(quantity × unit_price, 2) − discount
subtotal   = Σ line_total
total      = subtotal + shipping
balance    = total − amount_paid
```

Where the revised unit price is `unit_price × (1 − rate/100)` for a percentage,
the rate itself for a fixed price, and `unit_price` when no revised rate is
set. Both clamps matter: a fixed price above list produces no discount rather
than a negative one.

On a sales order line, `discount` is written by a trigger and `line_total` is a
generated column, so neither can be sent by a client. On an invoice line both
are plain stored columns, because an invoice line is a snapshot of what was
true at issue rather than a live calculation.
