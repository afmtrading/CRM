-- =============================================================================
-- What a document says about who sent it
--
-- The printed purchase order carried the order and almost nothing about the
-- business sending it: no letterhead, no way to reach the representative whose
-- name was on it, no standing terms, no page numbers. Four columns close that,
-- and a fifth decides whether the discount is anybody else's business.
--
-- Nothing here is computed from anything else, so all of it is stored.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reaching the representative
--
-- A document names a person and then gives the reader no way to reach them.
-- The name and the email are already on the row; the phone is the piece that
-- was missing, and it is the one a customer holding a printed order actually
-- uses.
--
-- On users rather than on the order: it is the person's number, the same on
-- every document they put their name to, and a copy per order would be a
-- hundred places to correct when they change desks.
-- -----------------------------------------------------------------------------

alter table public.users
  add column if not exists phone text;

comment on column public.users.phone is
  'How a customer reaches this person — printed on documents they represent. Theirs rather than the organization''s switchboard.';

-- -----------------------------------------------------------------------------
-- The standing terms
--
-- Twice now a per-document terms box has been added and removed, because the
-- wording never actually varied by document: it is the same sentence about
-- returns on every order this business has ever sent. So it is stored once,
-- for the organization, and printed on all of them.
--
-- Null means the section does not appear, which is what every organization
-- gets until somebody writes theirs.
-- -----------------------------------------------------------------------------

alter table public.organizations
  add column if not exists document_terms text;

comment on column public.organizations.document_terms is
  'Terms and conditions printed at the foot of every purchase order and invoice. One wording for the organization — the per-document box was removed twice because the text never varied.';

-- -----------------------------------------------------------------------------
-- Whether the discount shows
--
-- What a line was reduced from is sometimes the point of the document and
-- sometimes nobody's business — the same order sent to a customer and filed
-- internally wants different answers. So it is a property of the document
-- rather than a switch on the screen printing it: whoever downloads an order
-- gets the same paper as everybody else who downloads it.
--
-- Defaults to showing, which is what both documents do today. A default of
-- false would silently change every existing document the first time somebody
-- reprinted one.
-- -----------------------------------------------------------------------------

alter table public.sales_orders
  add column if not exists show_discount boolean not null default true;

alter table public.invoices
  add column if not exists show_discount boolean not null default true;

comment on column public.sales_orders.show_discount is
  'Whether the printed document shows what each line was discounted from. The totals are unaffected either way — this hides a column, not money.';
comment on column public.invoices.show_discount is
  'Whether the printed document shows what each line was discounted from. The totals are unaffected either way — this hides a column, not money.';

-- -----------------------------------------------------------------------------
-- And the hole that a profile page would have widened
--
-- `users_update` has always let somebody update their own row:
--
--     using (organization_id = current_org_id()
--            and (is_org_admin() or id = current_app_user_id()))
--     with check (organization_id = current_org_id())
--
-- The check constrains the organization and nothing else, so the row a person
-- may write is their own *entire* row — including `role`. Any authenticated
-- user could set themselves to owner, or move themselves onto a permission set
-- they were never granted, with one request straight at PostgREST. The session
-- lives in the browser, so this needs no more than the network tab.
--
-- It has been reachable for as long as the policy has existed. It is fixed
-- here rather than separately because this migration is what turns editing
-- your own row into a supported feature: the profile page writes a name and a
-- phone, and this makes that the *only* thing a non-administrator can write,
-- whatever they send.
--
-- An administrator is unaffected — changing somebody's role is their job, and
-- they reach this trigger with is_org_admin() true.
-- -----------------------------------------------------------------------------

/*
 * INVOKER, and that is the whole trick.
 *
 * `security definer` rewrites current_user to the function's owner for the
 * duration of the call, so a definer version of this function sees `postgres`
 * no matter who called it — the role gate below would then be true for
 * everybody and the guard would never fire. It reads nothing but session
 * settings and two functions the authenticated role already executes in
 * policies, so it needs no elevated rights at all.
 */
create or replace function public.users_guard_self_update()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
begin
  /*
   * Only requests that arrive as `authenticated`, which is the role PostgREST
   * assumes for a signed-in browser and therefore the only population that can
   * craft the request this exists to refuse.
   *
   * The gate is the Postgres role rather than the app user, because
   * `current_app_user_id()` reads a session setting that outlives a `set role`
   * — a migration or an operator acting as postgres in a session that had
   * signed somebody in earlier still resolves to that person. Guarding on the
   * app user alone therefore refuses an administrator's own maintenance,
   * which is exactly what the roles suite caught: `set local role postgres;
   * update users set status = 'disabled'` failed because the previous
   * sign-in was a manager.
   *
   * Everything else — service_role, postgres, a definer function owned by
   * postgres — is vetted code or somebody holding a key, and neither is
   * somebody editing their own profile.
   */
  if current_user <> 'authenticated' then
    return new;
  end if;

  v_actor := public.current_app_user_id();

  -- Authenticated but resolving to no app user at all. Nothing to protect.
  if v_actor is null then
    return new;
  end if;

  if public.is_org_admin() then
    return new;
  end if;

  /*
   * Somebody else's row. users_update already refuses this for a
   * non-administrator; returning rather than raising keeps the refusal in one
   * place and stops this trigger inventing a second, differently-worded one.
   */
  if old.id is distinct from v_actor then
    return new;
  end if;

  /*
   * Everything a person does not get to say about themselves. Listed as
   * equalities rather than by copying old onto new, so a column added later
   * is not silently made self-writable by this function's silence about it —
   * it will simply not be guarded, and that is a review away rather than a
   * privilege away. `is not distinct from` because these are nullable and
   * null <> null is not false, it is null.
   */
  if new.role is distinct from old.role
     or new.permission_set_id is distinct from old.permission_set_id
     or new.status is distinct from old.status
     or new.email is distinct from old.email
     or new.organization_id is distinct from old.organization_id
     or new.auth_provider_id is distinct from old.auth_provider_id
  then
    raise exception 'Only an administrator can change that';
  end if;

  return new;
end;
$$;

comment on function public.users_guard_self_update() is
  'Holds a non-administrator to their own name and phone when they update their own row. Without it users_update''s check permits self-promotion to owner.';

drop trigger if exists users_guard_self_update on public.users;
create trigger users_guard_self_update
  before update on public.users
  for each row execute function public.users_guard_self_update();
