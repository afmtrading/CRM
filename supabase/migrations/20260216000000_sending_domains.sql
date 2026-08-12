-- =============================================================================
-- Who an organization sends email as
--
-- One row per account, because that was the decision: AFM sends as AFM from its
-- own verified domain, FLO as FLO, and a third account gets its own rather than
-- borrowing somebody else's. Sending reputation is earned per domain, so
-- sharing one would mean one account's bad campaign costing another its
-- deliverability.
--
-- The postal address is not decoration either. Marketing email is required to
-- carry a real physical address in every message under US law, and it is the
-- kind of requirement that is trivial to satisfy up front and impossible to
-- satisfy retroactively for mail already sent.
-- =============================================================================

create table if not exists sending_domains (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,

  /** The verified subdomain, e.g. news.flo-ventures.com. */
  domain          text not null,
  /** What a recipient sees in the From line. */
  from_name       text not null,
  /** The local part only — the domain above completes it. */
  from_local      text not null default 'hello',
  /**
   * Where replies land. Deliberately a different mailbox from the sending
   * domain: the sending subdomain does not receive, and a reply nobody reads
   * is worse than no reply address at all.
   */
  reply_to        text,
  /** Required in the footer of every marketing message. */
  postal_address  text,

  /** Resend's own id for the domain, so its status can be re-checked later. */
  provider_id     text,
  verified        boolean not null default false,

  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One sending identity per organization for now. A second would need a way to
-- choose between them on every campaign, which is a decision nobody has needed
-- to make yet.
create unique index if not exists sending_domains_one_per_org
  on sending_domains (organization_id);

comment on table sending_domains is
  'The From address an organization''s campaigns go out as. One per account, so reputations stay separate.';

alter table sending_domains enable row level security;
alter table sending_domains force row level security;

create policy sending_domains_select on sending_domains
  for select to authenticated
  using (organization_id = public.current_org_id());

-- Changing who the company sends email as is an administrator's decision: it is
-- the name on every message that leaves the building.
create policy sending_domains_insert on sending_domains
  for insert to authenticated
  with check (organization_id = public.current_org_id() and public.is_org_admin());

create policy sending_domains_update on sending_domains
  for update to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin())
  with check (organization_id = public.current_org_id());

create policy sending_domains_delete on sending_domains
  for delete to authenticated
  using (organization_id = public.current_org_id() and public.is_org_admin());

grant select, insert, update, delete on sending_domains to authenticated;
