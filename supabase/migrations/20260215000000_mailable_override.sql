-- =============================================================================
-- A manual yes or no on whether a contact may be emailed
--
-- The consent model answers "on what basis" — express, implied, none — and
-- that basis is what makes a send defensible. But it is also more machinery
-- than a person wants between them and an obvious decision, and somebody who
-- knows a contact well should be able to say plainly: yes, send to them.
--
-- So: an override. Three states rather than two, because "follow the rules" is
-- different from "yes" and is what every contact should start as.
--
--   null   follow the consent rules (the default)
--   true   yes, send — I vouch for this
--   false  no, never send — whatever the consent says
--
-- Two things it deliberately cannot do, and the reasons are not squeamishness:
--
--   * it cannot un-unsubscribe somebody. A person who asked to stop has asked
--     to stop, and quietly reversing that is both the thing anti-spam law
--     actually punishes and a promise broken.
--
--   * it cannot resurrect an address that hard-bounced or generated a
--     complaint. That address does not work, or its owner marked the last one
--     as spam; sending again damages the sending domain's reputation for
--     everybody else on it.
--
-- Those two stay above the override. Everything else — no consent recorded,
-- implied consent aged out — is exactly what it is for.
-- =============================================================================

alter table contacts
  add column if not exists mailable_override    boolean,
  add column if not exists mailable_override_at timestamptz,
  add column if not exists mailable_override_by uuid references users (id) on delete set null;

comment on column contacts.mailable_override is
  'null follows the consent rules, true vouches for them, false excludes them. Cannot override an unsubscribe or a bounce.';
comment on column contacts.mailable_override_at is
  'When the override was set, so a decision made long ago can be seen for what it is.';

-- Stamped automatically, so an override always carries who made the call and
-- when without anybody having to remember to fill it in.
create or replace function public.contacts_stamp_override()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.mailable_override is distinct from old.mailable_override then
    if new.mailable_override is null then
      new.mailable_override_at := null;
      new.mailable_override_by := null;
    else
      new.mailable_override_at := now();
      new.mailable_override_by := public.current_app_user_id();
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists contacts_stamp_override on contacts;
create trigger contacts_stamp_override
  before update on contacts
  for each row execute function public.contacts_stamp_override();

-- -----------------------------------------------------------------------------
-- Mailability, with the override folded in
--
-- The order of these branches is the whole design. Anything above the override
-- is something the override cannot reach.
-- -----------------------------------------------------------------------------
-- Dropped rather than replaced: `create or replace view` can only append
-- columns, and mailable_override belongs beside the other consent fields
-- rather than tacked on after the reason it feeds.
drop view if exists contact_mailability;

create view contact_mailability
with (security_invoker = true) as
select
  c.id            as contact_id,
  c.organization_id,
  c.email,
  c.marketing_consent,
  c.consent_at,
  c.mailable_override,
  case
    -- Nothing to send to. No override makes an address appear.
    when c.email is null or btrim(c.email) = ''      then 'no_email'

    -- Above the override on purpose: they asked to stop.
    when c.marketing_consent = 'unsubscribed'        then 'unsubscribed'

    -- Also above it: the address bounced or its owner complained. Sending
    -- again costs the whole sending domain, not just this one contact.
    when exists (
      select 1 from email_suppressions s
      where s.organization_id = c.organization_id
        and lower(s.email) = lower(c.email)
    )                                                then 'suppressed'

    -- A manual no beats everything below, including express consent.
    when c.mailable_override is false                then 'excluded'

    -- And a manual yes stands in for a consent basis.
    when c.mailable_override is true                 then null

    when c.marketing_consent = 'none'                then 'no_consent'
    when c.marketing_consent = 'implied'
     and (c.consent_at is null or c.consent_at < now() - interval '2 years')
                                                     then 'consent_expired'
    else null
  end             as blocked_reason
from contacts c
where c.deleted_at is null
  and c.duplicate_of_id is null;

comment on view contact_mailability is
  'One row per live contact. blocked_reason is null when they may be emailed, and otherwise says why not. An unsubscribe and a bounce sit above the manual override and cannot be overridden.';

grant select on contact_mailability to authenticated;

-- -----------------------------------------------------------------------------
-- The override is a bulk field too
--
-- Only one branch of bulk_update_records changes: the list of contact columns
-- it will accept. The scalar path already casts through the column's real type,
-- so a boolean needs nothing special beyond permission to be written.
-- -----------------------------------------------------------------------------
create or replace function public.bulk_update_records(
  p_entity text,
  p_ids uuid[],
  p_field text,
  p_mode text,
  p_values text[]
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_org    uuid := public.current_org_id();
  v_table  text;
  v_kind   text;
  v_key    text;
  v_type   text;
  v_values text[] := coalesce(p_values, '{}');
  v_count  integer;
begin
  if v_org is null then
    raise exception 'No organization in context';
  end if;

  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  if array_length(p_ids, 1) > 500 then
    raise exception 'Too many records in one change (limit 500)';
  end if;

  if p_mode not in ('set', 'add', 'remove', 'clear') then
    raise exception 'Unknown change %', p_mode;
  end if;

  v_table := case p_entity
    when 'contact' then 'contacts'
    when 'company' then 'companies'
    else null
  end;

  if v_table is null then
    raise exception 'Cannot bulk edit %', p_entity;
  end if;

  if p_field like 'custom_fields.%' then
    v_key := substring(p_field from 15);

    if not exists (
      select 1 from public.custom_field_definitions
      where organization_id = v_org
        and entity_type::text = p_entity
        and key = v_key
    ) then
      raise exception 'No such field %', v_key;
    end if;

    v_kind := 'json';
  elsif p_entity = 'contact' and p_field in
    ('owner_id', 'company_id', 'lifecycle_stage', 'priority', 'credibility', 'mailable_override')
  then
    v_kind := 'scalar';
  elsif p_entity = 'contact' and p_field = 'role_type' then
    v_kind := 'array';
  elsif p_entity = 'company' and p_field = 'owner_id' then
    v_kind := 'scalar';
  elsif p_entity = 'company' and p_field in ('specialty_market', 'customer_type') then
    v_kind := 'array';
  else
    raise exception 'Field % cannot be changed in bulk', p_field;
  end if;

  if v_kind = 'scalar' then
    select format_type(a.atttypid, a.atttypmod)
    into v_type
    from pg_attribute a
    where a.attrelid = format('public.%I', v_table)::regclass
      and a.attname = p_field
      and a.attnum > 0;

    execute format(
      'update public.%I set %I = nullif($1, '''')::%s
       where id = any($2) and organization_id = $3',
      v_table, p_field, v_type
    )
    using case when p_mode = 'clear' then '' else coalesce(v_values[1], '') end, p_ids, v_org;

  elsif v_kind = 'array' then
    if p_mode = 'clear' then
      execute format(
        'update public.%I set %I = ''{}''::text[]
         where id = any($1) and organization_id = $2',
        v_table, p_field
      ) using p_ids, v_org;

    elsif p_mode = 'set' then
      execute format(
        'update public.%I set %I = $1
         where id = any($2) and organization_id = $3',
        v_table, p_field
      ) using v_values, p_ids, v_org;

    elsif p_mode = 'add' then
      execute format(
        'update public.%I set %I = coalesce(%I, ''{}'') || (
           select coalesce(array_agg(v), ''{}'')
           from unnest($1) v
           where not (v = any(coalesce(%I, ''{}'')))
         )
         where id = any($2) and organization_id = $3',
        v_table, p_field, p_field, p_field
      ) using v_values, p_ids, v_org;

    else
      execute format(
        'update public.%I set %I = (
           select coalesce(array_agg(v), ''{}'')
           from unnest(coalesce(%I, ''{}'')) v
           where not (v = any($1))
         )
         where id = any($2) and organization_id = $3',
        v_table, p_field, p_field
      ) using v_values, p_ids, v_org;
    end if;

  else
    if p_mode = 'clear' then
      execute format(
        'update public.%I set custom_fields = coalesce(custom_fields, ''{}''::jsonb) - $1
         where id = any($2) and organization_id = $3',
        v_table
      ) using v_key, p_ids, v_org;

    elsif p_mode = 'set' then
      execute format(
        'update public.%I
         set custom_fields = jsonb_set(coalesce(custom_fields, ''{}''::jsonb), array[$1], $2, true)
         where id = any($3) and organization_id = $4',
        v_table
      ) using
        v_key,
        case
          when array_length(v_values, 1) is null then '""'::jsonb
          when array_length(v_values, 1) = 1 then to_jsonb(v_values[1])
          else to_jsonb(v_values)
        end,
        p_ids,
        v_org;

    else
      raise exception 'A custom field can only be set or cleared, not %', p_mode;
    end if;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end
$fn$;

revoke execute on function public.bulk_update_records(text, uuid[], text, text, text[]) from public;
grant execute on function public.bulk_update_records(text, uuid[], text, text, text[])
  to authenticated, service_role;
