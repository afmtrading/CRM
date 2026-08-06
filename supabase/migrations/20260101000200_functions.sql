-- =============================================================================
-- FLO CRM — Business logic that belongs in the database
--
-- Anything that must be atomic (merge), must not drift from the data
-- (reporting), or must run identically no matter which client wrote the row
-- (lead scoring) lives here. Everything is security invoker unless noted, so
-- RLS still applies to the caller.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Auth linking
--
-- Users are provisioned by an admin, not by public signup (PRD 1.3). The admin
-- creates a users row with status 'invited'; when that person completes their
-- Supabase Auth sign-in, this trigger binds the two together.
-- -----------------------------------------------------------------------------
create or replace function public.link_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.users
  set auth_provider_id = new.id,
      status = case when status = 'invited' then 'active'::user_status else status end
  where lower(email) = lower(new.email)
    and auth_provider_id is null;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.link_auth_user();

-- -----------------------------------------------------------------------------
-- Lead scoring (PRD 5.12, 6.5)
--
-- A contact's score is the sum of the points of every active rule it matches.
-- Rules address standard columns by name, or custom fields as
-- "custom_fields.key".
-- -----------------------------------------------------------------------------
create or replace function public.contact_field_text(p_contact contacts, p_field text)
returns text
language plpgsql
immutable
as $$
begin
  if p_field like 'custom_fields.%' then
    return p_contact.custom_fields ->> substring(p_field from 15);
  end if;

  return case p_field
    when 'first_name'      then p_contact.first_name
    when 'last_name'       then p_contact.last_name
    when 'email'           then p_contact.email
    when 'phone'           then p_contact.phone
    when 'source'          then p_contact.source
    when 'lifecycle_stage' then p_contact.lifecycle_stage::text
    when 'lead_score'      then p_contact.lead_score::text
    else null
  end;
end;
$$;

create or replace function public.calculate_lead_score(p_contact contacts)
returns integer
language plpgsql
stable
as $$
declare
  r       lead_score_rules;
  v_total integer := 0;
  v_field text;
  v_num   numeric;
  v_rule  numeric;
begin
  for r in
    select * from lead_score_rules
    where organization_id = p_contact.organization_id and is_active
  loop
    v_field := public.contact_field_text(p_contact, r.field);

    case r.condition
      when 'equals' then
        if v_field is not null and lower(v_field) = lower(coalesce(r.value, '')) then
          v_total := v_total + r.points;
        end if;
      when 'not_equals' then
        if v_field is null or lower(v_field) <> lower(coalesce(r.value, '')) then
          v_total := v_total + r.points;
        end if;
      when 'contains' then
        if v_field is not null and coalesce(r.value, '') <> ''
           and position(lower(r.value) in lower(v_field)) > 0 then
          v_total := v_total + r.points;
        end if;
      when 'is_filled' then
        if v_field is not null and btrim(v_field) <> '' then
          v_total := v_total + r.points;
        end if;
      when 'is_empty' then
        if v_field is null or btrim(v_field) = '' then
          v_total := v_total + r.points;
        end if;
      when 'greater_than' then
        begin
          v_num  := v_field::numeric;
          v_rule := r.value::numeric;
          if v_num > v_rule then v_total := v_total + r.points; end if;
        exception when others then null;
        end;
      when 'less_than' then
        begin
          v_num  := v_field::numeric;
          v_rule := r.value::numeric;
          if v_num < v_rule then v_total := v_total + r.points; end if;
        exception when others then null;
        end;
    end case;
  end loop;

  return v_total;
end;
$$;

-- Keep the stored score current on every write, so list views can sort and
-- filter on it without recomputing.
create or replace function public.contacts_apply_lead_score()
returns trigger
language plpgsql
as $$
begin
  new.lead_score := public.calculate_lead_score(new);
  return new;
end;
$$;

create trigger contacts_apply_lead_score
  before insert or update of first_name, last_name, email, phone, source,
                             lifecycle_stage, custom_fields, organization_id
  on contacts
  for each row execute function public.contacts_apply_lead_score();

-- POST /contacts/score/recalculate — re-run the rules over existing contacts
-- after a rule changes (PRD Section 9). Returns the number of contacts whose
-- score actually moved.
create or replace function public.recalculate_lead_scores()
returns integer
language plpgsql
as $$
declare
  v_org     uuid := public.current_org_id();
  v_changed integer;
begin
  if v_org is null then
    raise exception 'no organization context';
  end if;

  with recomputed as (
    select c.id, public.calculate_lead_score(c) as score
    from contacts c
    where c.organization_id = v_org
  )
  update contacts c
  set lead_score = r.score
  from recomputed r
  where c.id = r.id and c.lead_score is distinct from r.score;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

-- -----------------------------------------------------------------------------
-- Duplicate detection (PRD 6.2)
--
-- Matching email, or name + phone. Scoped to the caller's organization, and to
-- records that have not themselves already been merged away.
-- -----------------------------------------------------------------------------

-- Phone numbers are compared on their last 10 digits, so the same number
-- written with a country code, spaces or punctuation still matches.
create or replace function public.normalize_phone(p_phone text)
returns text
language sql
immutable
as $$
  select right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 10);
$$;

create or replace function public.find_duplicate_contacts(
  p_email      text default null,
  p_first_name text default null,
  p_last_name  text default null,
  p_phone      text default null,
  p_exclude_id uuid default null
)
returns setof contacts
language sql
stable
as $$
  select c.*
  from contacts c
  where c.organization_id = public.current_org_id()
    and c.duplicate_of_id is null
    and (p_exclude_id is null or c.id <> p_exclude_id)
    and (
      (
        p_email is not null and btrim(p_email) <> ''
        and lower(c.email) = lower(btrim(p_email))
      )
      or (
        p_phone is not null and btrim(p_phone) <> ''
        -- Compare the last 10 digits, so "+1 (416) 555-0100" and "4165550100"
        -- are recognised as the same number.
        and length(regexp_replace(p_phone, '[^0-9]', '', 'g')) >= 7
        and public.normalize_phone(c.phone) = public.normalize_phone(p_phone)
        and lower(coalesce(c.first_name, '')) = lower(coalesce(p_first_name, ''))
        and lower(coalesce(c.last_name, ''))  = lower(coalesce(p_last_name, ''))
      )
    )
  order by c.created_at;
$$;

-- Whole-organization duplicate sweep for the on-demand dedupe tool (6.7).
create or replace function public.find_duplicate_groups()
returns table (match_key text, match_type text, contact_ids uuid[], contact_count bigint)
language sql
stable
as $$
  with scoped as (
    select * from contacts
    where organization_id = public.current_org_id() and duplicate_of_id is null
  ),
  by_email as (
    select lower(email) as key, 'email' as kind, array_agg(id order by created_at) as ids, count(*) as n
    from scoped
    where email is not null and btrim(email) <> ''
    group by lower(email)
    having count(*) > 1
  ),
  by_name_phone as (
    select lower(first_name) || ' ' || lower(last_name) || ' / ' || public.normalize_phone(phone) as key,
           'name_phone' as kind,
           array_agg(id order by created_at) as ids,
           count(*) as n
    from scoped
    where phone is not null and length(public.normalize_phone(phone)) >= 7
    group by 1
    having count(*) > 1
  )
  select key, kind, ids, n from by_email
  union all
  select key, kind, ids, n from by_name_phone
  -- Positional: the branches of a UNION do not expose their aliases here.
  order by 4 desc, 1;
$$;

-- -----------------------------------------------------------------------------
-- POST /contacts/{id}/merge (PRD 6.2, Section 9)
--
-- Folds p_source_id into p_target_id: the target keeps its own values and
-- inherits anything it was missing, the source's deals, activities and tags are
-- reassigned, and the source row survives as a tombstone pointing at the
-- target so old links still resolve.
-- -----------------------------------------------------------------------------
create or replace function public.merge_contacts(p_target_id uuid, p_source_id uuid)
returns contacts
language plpgsql
as $$
declare
  v_org    uuid := public.current_org_id();
  v_target contacts;
  v_source contacts;
begin
  if p_target_id = p_source_id then
    raise exception 'cannot merge a contact into itself';
  end if;

  select * into v_target from contacts where id = p_target_id and organization_id = v_org;
  select * into v_source from contacts where id = p_source_id and organization_id = v_org;

  if v_target.id is null or v_source.id is null then
    raise exception 'both contacts must exist in the current organization';
  end if;

  update deals      set contact_id = p_target_id where contact_id = p_source_id and organization_id = v_org;
  update activities set related_to_id = p_target_id
    where related_to_type = 'contact' and related_to_id = p_source_id and organization_id = v_org;

  insert into contact_tags (organization_id, contact_id, tag_id)
  select v_org, p_target_id, tag_id from contact_tags where contact_id = p_source_id
  on conflict do nothing;
  delete from contact_tags where contact_id = p_source_id;

  update contacts
  set first_name      = case when btrim(coalesce(first_name, '')) = '' then v_source.first_name else first_name end,
      last_name       = case when btrim(coalesce(last_name, ''))  = '' then v_source.last_name  else last_name  end,
      email           = coalesce(email, v_source.email),
      phone           = coalesce(phone, v_source.phone),
      company_id      = coalesce(company_id, v_source.company_id),
      owner_id        = coalesce(owner_id, v_source.owner_id),
      source          = coalesce(source, v_source.source),
      -- Target values win on key collisions.
      custom_fields   = v_source.custom_fields || custom_fields
  where id = p_target_id
  returning * into v_target;

  -- Tombstone: keep the row, point it at the survivor, strip the unique-ish
  -- identifiers so it stops showing up as a duplicate of the target.
  update contacts
  set duplicate_of_id = p_target_id,
      email           = null,
      phone           = null
  where id = p_source_id;

  return v_target;
end;
$$;

-- -----------------------------------------------------------------------------
-- Lead assignment / routing (PRD 6.5)
--
-- Returns the user a new contact should be assigned to, applying the highest
-- priority active rule that matches. Round-robin advances a cursor stored on
-- the rule, so assignment is even across users rather than random.
-- -----------------------------------------------------------------------------
create or replace function public.next_assignee(p_source text default null)
returns uuid
language plpgsql
as $$
declare
  v_org     uuid := public.current_org_id();
  r         assignment_rules;
  v_user_id uuid;
begin
  for r in
    select * from assignment_rules
    where organization_id = v_org and is_active
    order by priority, created_at
  loop
    if r.strategy = 'by_source' then
      if p_source is not null and lower(coalesce(r.source_match, '')) = lower(p_source) then
        return r.fixed_user_id;
      end if;

    elsif r.strategy = 'fixed_user' then
      return r.fixed_user_id;

    elsif r.strategy = 'round_robin' then
      -- Next active user after the cursor, wrapping around.
      --
      -- Ordered by (created_at, id), not created_at alone: users created in the
      -- same transaction share a timestamp, and a tie there would park the
      -- cursor on one person forever.
      select u.id into v_user_id
      from users u
      where u.organization_id = v_org and u.status = 'active'
        and (
          r.last_assigned_id is null
          or (u.created_at, u.id) >
             (select created_at, id from users where id = r.last_assigned_id)
        )
      order by u.created_at, u.id
      limit 1;

      if v_user_id is null then
        select u.id into v_user_id
        from users u
        where u.organization_id = v_org and u.status = 'active'
        order by u.created_at, u.id
        limit 1;
      end if;

      if v_user_id is not null then
        update assignment_rules set last_assigned_id = v_user_id where id = r.id;
        return v_user_id;
      end if;
    end if;
  end loop;

  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- GET /reports/pipeline-value (PRD 6.8, Section 9)
--
-- Computed live from the deals table on every call. No materialised view, no
-- cache: the acceptance criterion is that the number always matches a manual
-- sum of open deals.
-- -----------------------------------------------------------------------------
create or replace function public.report_pipeline_value(
  p_pipeline_id uuid default null,
  p_owner_id    uuid default null
)
returns table (
  stage_id            uuid,
  stage_name          text,
  stage_order         integer,
  pipeline_id         uuid,
  pipeline_name       text,
  owner_id            uuid,
  owner_name          text,
  deal_count          bigint,
  total_value         numeric,
  weighted_value      numeric
)
language sql
stable
as $$
  select
    s.id,
    s.name,
    s."order",
    p.id,
    p.name,
    u.id,
    coalesce(u.name, u.email, 'Unassigned'),
    count(d.id),
    coalesce(sum(d.value), 0),
    coalesce(sum(d.value * d.probability), 0)
  from stages s
  join pipelines p on p.id = s.pipeline_id
  left join deals d
    on d.stage_id = s.id
   and d.status = 'open'
   and d.organization_id = public.current_org_id()
   and (p_owner_id is null or d.owner_id = p_owner_id)
  left join users u on u.id = d.owner_id
  where s.organization_id = public.current_org_id()
    and (p_pipeline_id is null or s.pipeline_id = p_pipeline_id)
  group by s.id, s.name, s."order", p.id, p.name, u.id, u.name, u.email
  order by p.name, s."order", coalesce(u.name, u.email);
$$;

grant execute on function public.recalculate_lead_scores() to authenticated;
grant execute on function public.normalize_phone(text) to authenticated;
grant execute on function public.find_duplicate_contacts(text, text, text, text, uuid) to authenticated;
grant execute on function public.find_duplicate_groups() to authenticated;
grant execute on function public.merge_contacts(uuid, uuid) to authenticated;
grant execute on function public.next_assignee(text) to authenticated;
grant execute on function public.report_pipeline_value(uuid, uuid) to authenticated;
grant execute on function public.calculate_lead_score(contacts) to authenticated;
grant execute on function public.contact_field_text(contacts, text) to authenticated;
