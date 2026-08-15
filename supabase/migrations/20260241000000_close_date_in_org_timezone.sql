-- -----------------------------------------------------------------------------
-- A deal closes on the organization's day, not the server's
--
-- 20260231000000 moved every date on the deal ledger into the organization's
-- timezone, and left a comment saying so:
--
--   Counted between two days in the same zone. Mixing a user-entered close
--   date with a UTC-derived creation day used to make a deal opened late on a
--   Monday and closed on the Tuesday look like it took no time at all.
--
-- The comment was right about the principle and wrong about the facts. It
-- converted created_at and closed_at into the organization's zone, but
-- actual_close_date was already a plain date and was left alone — and the
-- trigger that stamps it uses `current_date`, which is the *server's* today.
-- So the two zones were still mixed, just in the other direction.
--
-- The visible symptom is a deal won at 8pm in Toronto. It is stamped with
-- tomorrow's UTC date, its creation day resolves to today in Toronto, and it
-- reports a one-day sales cycle for work that took an hour. Everything closed
-- in the evening is a day slow, all year.
--
-- The fix is where the date is made rather than where it is read.
-- actual_close_date is a date somebody may type by hand, and when they do they
-- mean their own calendar; the automatic stamp should mean the same thing.
-- -----------------------------------------------------------------------------

/**
 * Today, in an organization's own zone.
 *
 * Takes the organization rather than reading current_org_id(), because this is
 * called from triggers — and a trigger fires for imports, for service-role
 * work and for the seed, none of which have a signed-in caller to ask. The row
 * always knows which organization it belongs to.
 *
 * Falls back to UTC for a row whose organization has vanished, which is the
 * same fallback deal_ledger already makes.
 */
create or replace function public.org_today(p_org uuid)
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (
    now() at time zone coalesce(
      (select o.timezone from public.organizations o where o.id = p_org),
      'UTC'
    )
  )::date;
$$;

comment on function public.org_today(uuid) is
  'Today as the organization would write it. Use instead of current_date anywhere a stored date has to line up with the dates on a report.';

revoke execute on function public.org_today(uuid) from public, anon;
grant execute on function public.org_today(uuid) to authenticated, service_role;

/*
 * Recreated in full rather than patched: one line changes, but a trigger
 * function has no ALTER that edits a statement in place, and the probability
 * half has to come along unchanged or it is lost.
 */
create or replace function public.deals_apply_stage_probability()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_default numeric(4, 3);
begin
  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    if not new.probability_overridden then
      select default_probability into v_default from stages where id = new.stage_id;
      if v_default is not null then
        new.probability = v_default;
      end if;
    end if;
  end if;

  -- Closing a deal stamps the close date; reopening clears it. The day is the
  -- organization's, so it can be subtracted from the other dates on the ledger
  -- without crossing calendars.
  if new.status in ('won', 'lost') and new.actual_close_date is null then
    new.actual_close_date = public.org_today(new.organization_id);
  elsif new.status = 'open' then
    new.actual_close_date = null;
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Deals already stamped
--
-- Not corrected here, deliberately. actual_close_date is editable, so a date
-- that disagrees with closed_at might be the old bug or might be somebody
-- typing the day the customer actually signed — and nothing in the row tells
-- the two apart. Overwriting the second kind to fix the first would be a worse
-- error than the one being fixed, and a silent one.
--
-- Deals closed from now on are right. Anyone who wants the history rewritten
-- can do it deliberately, knowing what it costs:
--
--   update public.deals d
--   set actual_close_date = (d.closed_at at time zone o.timezone)::date
--   from public.organizations o
--   where d.organization_id = o.id
--     and d.closed_at is not null
--     and d.actual_close_date <> (d.closed_at at time zone o.timezone)::date;
-- -----------------------------------------------------------------------------
