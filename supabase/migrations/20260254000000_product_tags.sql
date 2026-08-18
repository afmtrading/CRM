-- =============================================================================
-- Products get tags
--
-- Contacts and companies have had them since 20260201 and 20260202. A product
-- had none at all — not on the form, not on the record, no table — so there was
-- no "add them afterwards" either.
--
-- The same tags, not a second vocabulary. A tag is the organization's own word
-- for a thing that cuts across records ("Q4 push", "EU only"), and it is worth
-- nothing if the word means one thing on a contact and something else on a
-- line. So this is a third join onto the same `tags` table, exactly as
-- company_tags is a second.
-- =============================================================================

create table if not exists public.product_tags (
  organization_id uuid not null references organizations (id) on delete cascade,
  product_id      uuid not null references products (id) on delete cascade,
  tag_id          uuid not null references tags (id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (product_id, tag_id)
);

-- "Everything tagged Q4 push" reads by tag, so that is the way in.
create index if not exists product_tags_tag_idx
  on public.product_tags (organization_id, tag_id);

revoke all on public.product_tags from anon;
grant select, insert, update, delete on public.product_tags to authenticated;

alter table public.product_tags enable row level security;
alter table public.product_tags force row level security;

-- -----------------------------------------------------------------------------
-- Who may see and change one
--
-- Written in the shape 20260230 left the other two in: the organization check
-- wrapped in a scalar sub-select so it is evaluated once per statement rather
-- than once per row, and an EXISTS on the product itself so a join row can
-- never be more visible than the record it hangs off.
-- -----------------------------------------------------------------------------

drop policy if exists product_tags_select on public.product_tags;
create policy product_tags_select on public.product_tags
  for select to authenticated
  using (
    organization_id = (select public.current_org_id())
    and exists (select 1 from products p where p.id = product_tags.product_id)
  );

drop policy if exists product_tags_write on public.product_tags;
create policy product_tags_write on public.product_tags
  for all to authenticated
  using (
    organization_id = (select public.current_org_id())
    and (select public.can_write_records())
    and exists (select 1 from products p where p.id = product_tags.product_id)
  )
  with check (
    organization_id = (select public.current_org_id())
    and (select public.can_write_records())
  );

-- -----------------------------------------------------------------------------
-- The organization is derived, never supplied
--
-- Same guard the other two joins carry. The column exists so the policies above
-- can be a column comparison rather than a join, but letting a caller set it
-- would be letting them choose which organization's row this is — so the
-- trigger takes it from the product and refuses a tag from anywhere else.
-- -----------------------------------------------------------------------------

create or replace function public.product_tags_sync_organization()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_product_org uuid;
  v_tag_org     uuid;
begin
  select organization_id into v_product_org from products where id = new.product_id;
  select organization_id into v_tag_org     from tags     where id = new.tag_id;

  if v_product_org is null or v_tag_org is null or v_product_org <> v_tag_org then
    raise exception 'product and tag must belong to the same organization';
  end if;

  new.organization_id = v_product_org;
  return new;
end;
$$;

drop trigger if exists product_tags_sync_organization on public.product_tags;
create trigger product_tags_sync_organization
  before insert or update on public.product_tags
  for each row execute function public.product_tags_sync_organization();
