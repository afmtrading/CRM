-- =============================================================================
-- A fixed discount is money off, not a new price
--
-- `revised_rate_type` has always had two members that meant different kinds of
-- thing:
--
--   percent  a reduction        — 10 means "10% off"
--   fixed    a replacement      — 10 means "the unit is now 10"
--
-- That was defensible while the column on screen was called Revised Rate. It
-- stopped being defensible when it was renamed Discount, which is what the
-- desk reads and what a customer would read: entering $1 against a $6 unit
-- made the unit $1 rather than $5, and the line came to a third of what
-- anybody typing it expected.
--
-- So `fixed` now means the same kind of thing as `percent` — an amount taken
-- off each unit — and the two members of the enum finally answer the same
-- question in different units.
--
-- Clamped at zero as before: $20 off a $6 unit is a free unit, not money owed
-- back. That guard already existed for the same reason on the percentage side,
-- where 150% off would otherwise be a refund.
-- =============================================================================

create or replace function public.sales_line_discount(
  p_quantity    numeric,
  p_unit_price  numeric,
  p_rate_type   revised_rate_type,
  p_rate        numeric
)
returns numeric
language sql
immutable
parallel safe
as $$
  select round(
    greatest(
      0,
      coalesce(p_quantity, 0) * coalesce(p_unit_price, 0)
        - coalesce(p_quantity, 0) * greatest(
            0,
            case
              when p_rate_type is null or p_rate is null then coalesce(p_unit_price, 0)
              when p_rate_type = 'percent' then coalesce(p_unit_price, 0) * (1 - p_rate / 100)
              -- Was `p_rate`, which read as "the unit is now this".
              when p_rate_type = 'fixed'   then coalesce(p_unit_price, 0) - p_rate
            end
          )
    ),
    2
  );
$$;

comment on function public.sales_line_discount(numeric, numeric, revised_rate_type, numeric) is
  'Money off one line, given its revised rate. Percent and fixed both mean an amount taken off a unit. The single definition of the rule — SQL and TypeScript both follow it.';

-- -----------------------------------------------------------------------------
-- The totals already stored under the old reading
--
-- `discount` is written by a BEFORE trigger and `line_total` is generated from
-- it, so neither moves until the row is touched. Left alone, an order raised
-- yesterday would hold a total the database's own function no longer agrees
-- with — and would silently change the next time somebody edited an unrelated
-- field on the same line.
--
-- So the affected lines are touched here, deliberately and all at once, rather
-- than one at a time by surprise. Only rows with a fixed rate: a percentage
-- meant a reduction before and means one now.
--
-- The two this touches, and what they held, are written down in
-- docs/DATA_CHANGES.md — with the check that neither order has been invoiced,
-- so no issued document is restated by this.
--
-- `set revised_rate = revised_rate` is a no-op write whose only purpose is to
-- fire the trigger. The alternative is repeating the formula here, which is
-- the thing this migration exists to stop there being two of.
-- -----------------------------------------------------------------------------

update public.sales_order_lines
set revised_rate = revised_rate
where revised_rate_type = 'fixed';

/*
 * Invoice lines are not touched, and that is the point of them.
 *
 * They are a snapshot taken at conversion — the quantity, the price and the
 * discount as the document said them on the day it was issued. Restating one
 * because a rule changed afterwards would rewrite a document somebody has a
 * copy of. An invoice raised from a fixed-rate line before today therefore
 * keeps the total it was issued with, on purpose.
 */
