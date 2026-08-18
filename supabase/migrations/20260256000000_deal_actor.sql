-- =============================================================================
-- Who made this deal, and who touched it last
--
-- Contacts and companies have carried this since 20260201 and 20260202 and
-- show it on a Record history card. A deal carried only its timestamps, so the
-- same card on a deal could say when and never who — which is the half of the
-- question people actually ask.
--
-- Left null for the deals that already exist. The information was never
-- recorded, and inventing a plausible actor is worse than an honest blank:
-- "Unknown" is true, and a name that happens to be wrong is not.
-- =============================================================================

alter table public.deals add column if not exists created_by uuid references public.users (id);
alter table public.deals add column if not exists updated_by uuid references public.users (id);

comment on column public.deals.created_by is 'Who created the deal. Null for deals that predate 20260256.';
comment on column public.deals.updated_by is 'Who last changed the deal. Null for deals that predate 20260256.';

-- -----------------------------------------------------------------------------
-- Stamped by the database, not by the caller
--
-- Same body as stamp_company_actor, and the same reasoning: a value the client
-- sends is a value the client can get wrong or forge, and the one place that
-- always knows who is writing is the write itself.
--
-- coalesce on update rather than an overwrite, so a background write with no
-- session behind it cannot erase who last touched the record.
-- -----------------------------------------------------------------------------

create or replace function public.stamp_deal_actor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
begin
  select id into v_actor
  from public.users
  where auth_provider_id = auth.uid()
    and organization_id = new.organization_id
  limit 1;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, v_actor);
    new.updated_by := coalesce(new.updated_by, v_actor);
  else
    new.updated_by := coalesce(v_actor, old.updated_by);
  end if;

  return new;
end;
$$;

drop trigger if exists deals_stamp_actor on public.deals;
create trigger deals_stamp_actor
  before insert or update on public.deals
  for each row execute function public.stamp_deal_actor();
