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
