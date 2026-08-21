-- =============================================================================
-- A unit of measure on a sales order line
--
-- A line says how many, and until now the only thing that said *how many what*
-- was the product's own `unit`. That works for a line drawn from the catalogue
-- and not at all for the other kind: a non-inventoried line is a name somebody
-- typed, with no product row behind it and therefore no unit at all — so "12"
-- on such a line has never meant anything on its own.
--
-- The column is the line's own answer rather than a copy of the product's. Two
-- orders for the same product can genuinely be counted differently — a pallet
-- of towels on one and twelve units of the same towels on another — and a copy
-- of the catalogue's value would be wrong for whichever of them disagreed.
--
-- Null keeps meaning what it means today: nobody has said, and the line falls
-- back to the product's unit if it has a product. Nothing is backfilled for
-- that reason — a value invented here would be indistinguishable from one
-- somebody chose.
-- =============================================================================

alter table public.sales_order_lines
  add column if not exists unit text;

comment on column public.sales_order_lines.unit is
  'How many what — the line''s own unit of measure. Null falls back to the product''s unit, and on a non-inventoried line means nobody has said.';

/*
 * Not carried onto the invoice.
 *
 * `convert_sales_order_to_invoice` copies a fixed list of columns and
 * invoice_lines has no unit to copy into, so an invoice goes on reading the
 * product's unit exactly as it did before this migration. That is a smaller
 * gap than it looks — an invoice is a document about money, and the quantity
 * on it has always been the quantity on the order — but it is a gap, and it is
 * written down here rather than discovered later.
 */
