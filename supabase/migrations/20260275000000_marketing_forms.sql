-- =============================================================================
-- Marketing forms — the front door
--
-- WHY A CRM NEEDS FORMS
--
-- Everything else in here assumes the records already exist. Contacts can be
-- typed in, imported from a CSV, or matched out of a mailbox — all three are
-- ways of moving people who are already known into the database. None of them
-- is a way for somebody who is *not* known to arrive.
--
-- That gap is expensive in four separate ways, and a form closes all four at
-- once:
--
--   Capture      A stranger on a website becomes a contact row without anybody
--                retyping it off an email. The lead-scoring rules and the
--                assignment rules — both of which already exist and both of
--                which were written for exactly this moment — fire on the way
--                in, so the lead is scored and owned before anyone sees it.
--
--   Consent      This is the big one. contacts.marketing_consent already
--                distinguishes express consent ("they actively agreed — a
--                form, a tick box, a signature") from implied, and the whole
--                campaign feature refuses to send without one. Until now there
--                was no way in the product to *manufacture* express consent —
--                only to assert it after the fact on somebody's word. A form
--                submission is the only artefact that proves it: the exact
--                words shown, ticked at a known moment, from a known page. So
--                a submission row is not a log line, it is the receipt.
--
--   Attribution  utm_source, the referring page and the form's own source
--                value are recorded once, at the only moment they are knowable.
--                Ask a month later and nobody can tell you which advert paid
--                for which customer.
--
--   Follow-up    A lead nobody hears about is the same as no lead. A
--                submission notifies the person who now owns it, and can drop
--                the contact straight onto a mailing list, which is the
--                machinery already built next door.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No arbitrary column writing. A form question may fill one of a short, named
-- list of contact columns and nothing else — see submit_marketing_form. A form
-- that could write any column is a form a stranger can use to set lead_score,
-- owner_id or organization_id.
--
-- THE ANONYMOUS SURFACE
--
-- Two functions, and no table grants at all. The visitor has no account and
-- must not need one, exactly as with unsubscribing, so both run as definer:
-- one reads a published form, one accepts a submission. Everything else about
-- these tables is `authenticated` only.
-- =============================================================================

do $$
begin
  if to_regprocedure('public.current_org_id()') is null then
    raise exception 'Run the earlier migrations first — this one builds on current_org_id().';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- The form
-- -----------------------------------------------------------------------------
create table if not exists public.marketing_forms (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  /** Internal — what it is called in the CRM. Never shown to a visitor. */
  name            text not null,

  /*
   * The public address: /f/<slug>. Unique across every organization, because
   * the path carries no tenant — there is nothing in the URL to disambiguate
   * two accounts that both want "contact-us".
   *
   * Which is also why the application appends a short random suffix when it
   * generates one. Without it the first tenant to claim an obvious name would
   * hold it against everybody else, and "afm-quote" pointing at a competitor's
   * form is a tenancy problem wearing a naming problem's clothes. The suffix is
   * a default, not a rule: anybody may edit the slug to anything still free.
   */
  slug            text not null,

  /*
   * draft      being built; the public address 404s
   * published  live and accepting
   * closed     was live; the address still resolves and says so, rather than
   *            404ing on a link that may be printed on something
   */
  status          text not null default 'draft'
                  check (status in ('draft', 'published', 'closed')),

  -- What the visitor reads.
  headline        text not null,
  blurb           text,
  submit_label    text not null default 'Send',
  success_message text not null default 'Thanks — we have got that, and somebody will be in touch.',
  /** Sent to their own thank-you page instead of showing success_message. */
  redirect_url    text,
  /** Shown in place of the form once status is 'closed'. */
  closed_message  text not null default 'This form is no longer accepting responses.',

  /*
   * The questions, in order. An array of
   *   { key, label, type, required, maps_to, placeholder, help, options[] }
   * validated by the trigger below rather than trusted, because it is rendered
   * to the public and read by the submit path.
   */
  fields          jsonb not null default '[]'::jsonb,

  /*
   * What kind of consent submitting this form creates.
   *
   *   express  a tick box is shown, in the words below. Ticking it is what
   *            makes the consent express, so the box is never pre-ticked and
   *            never hidden.
   *   implied  no tick box. The submission itself is the business relationship
   *            — a quote request, a sample order — and it expires like every
   *            other implied consent.
   *   none     no marketing consent at all. Right for a support form, where
   *            treating a complaint as a subscription is how you get reported.
   */
  consent_basis   text not null default 'express'
                  check (consent_basis in ('express', 'implied', 'none')),
  consent_label   text not null default
                  'Yes, email me occasional news and offers. I can unsubscribe at any time.',
  /*
   * Whether the tick is required to submit. False by default and that matters:
   * asking for a quote and agreeing to a newsletter are two different acts, and
   * forcing them together is what makes consent indefensible. True belongs to
   * the forms whose entire purpose is the opt-in.
   */
  consent_required boolean not null default false,

  -- Where the lead goes.
  /** Written to contacts.source, and matched by the by-source assignment rules. */
  source          text,
  lifecycle_stage lifecycle_stage not null default 'lead',
  /** Added to this list on submission. Null means none. */
  list_id         uuid references public.email_lists (id) on delete set null,
  /** Fixed owner. Null hands the choice to the assignment rules (PRD 6.5). */
  owner_id        uuid references public.users (id) on delete set null,
  /** Told about every submission. Null tells whoever ends up owning it. */
  notify_user_id  uuid references public.users (id) on delete set null,

  -- Cheap counters, so the list screen does not aggregate the submissions table.
  submission_count   integer not null default 0,
  last_submission_at timestamptz,

  created_by      uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists marketing_forms_slug_key
  on public.marketing_forms (slug);
create index if not exists marketing_forms_org_idx
  on public.marketing_forms (organization_id, created_at desc);

comment on table public.marketing_forms is
  'A public lead-capture form. Its address carries no tenant, so slugs are unique across the whole installation.';

drop trigger if exists marketing_forms_updated_at on public.marketing_forms;
create trigger marketing_forms_updated_at
  before update on public.marketing_forms
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- The submission
--
-- Kept whole and kept forever, even though almost all of it is copied onto the
-- contact on the way past. The contact is a live record that people edit; this
-- is what was actually typed, on the day, on that page, under that wording. The
-- two answer different questions and only one of them is evidence.
-- -----------------------------------------------------------------------------
create table if not exists public.marketing_form_submissions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  form_id         uuid not null references public.marketing_forms (id) on delete cascade,
  /** Null only if the contact was later hard-deleted; the submission survives it. */
  contact_id      uuid references public.contacts (id) on delete set null,

  /*
   * Every answer as an array of { key, label, value }, not an object keyed by
   * field key. The label is frozen at submission time: rename a question next
   * month and this row still reads as the person answering it saw it.
   */
  answers         jsonb not null default '[]'::jsonb,

  -- Lifted out of the answers so the list screen and the dedupe path do not
  -- have to walk the array.
  email           text,
  name            text,

  /** Whether the box was ticked, and the exact words it was ticked against. */
  consent_given   boolean not null default false,
  consent_label   text,

  /*
   * True when the submission asked for something the consent record refuses to
   * give: an address that has unsubscribed, or one on the suppression list.
   *
   * Nothing is undone automatically. A new express opt-in is genuinely a valid
   * new consent, but a form can be filled in by somebody other than its
   * subject, and silently resurrecting an unsubscribe is the single mistake in
   * this area that turns into a complaint rather than a correction. So the
   * submission is kept, the flag is raised, and a person decides.
   */
  consent_conflict boolean not null default false,

  /*
   * Where they were. `page_url` is the referrer of the request that rendered
   * the form, which inside an embedded iframe is the customer's own page — the
   * one fact about the visit that is otherwise unknowable from here.
   */
  page_url        text,
  referrer        text,
  utm             jsonb not null default '{}'::jsonb,
  user_agent      text,

  created_at      timestamptz not null default now()
);

create index if not exists marketing_form_submissions_form_idx
  on public.marketing_form_submissions (form_id, created_at desc);
create index if not exists marketing_form_submissions_org_idx
  on public.marketing_form_submissions (organization_id, created_at desc);
create index if not exists marketing_form_submissions_contact_idx
  on public.marketing_form_submissions (contact_id) where contact_id is not null;
-- What the "needs a look" filter on the submissions screen reads.
create index if not exists marketing_form_submissions_conflict_idx
  on public.marketing_form_submissions (organization_id, created_at desc)
  where consent_conflict;

comment on table public.marketing_form_submissions is
  'What was actually submitted, kept verbatim. For an express-consent form this row is the proof of consent — the wording, the moment and the page.';

-- -----------------------------------------------------------------------------
-- The questions have to be questions
--
-- Validated here rather than in the application because two different callers
-- read this column — the public renderer and the submit function — and neither
-- of them is in a position to refuse a form that is already saved.
-- -----------------------------------------------------------------------------
create or replace function public.marketing_forms_check()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_field    jsonb;
  v_key      text;
  v_maps     text;
  v_keys     text[] := '{}';
  v_targets  text[] := '{}';
  v_has_mail boolean := false;
begin
  new.slug := lower(btrim(coalesce(new.slug, '')));

  if new.slug !~ '^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$' then
    raise exception 'A form address may use lower-case letters, numbers and hyphens, and must be at least three characters';
  end if;

  if jsonb_typeof(new.fields) <> 'array' then
    raise exception 'The questions must be a list';
  end if;

  if jsonb_array_length(new.fields) > 30 then
    raise exception 'A form may ask at most 30 questions';
  end if;

  for v_field in select value from jsonb_array_elements(new.fields) loop
    v_key  := v_field ->> 'key';
    v_maps := coalesce(v_field ->> 'maps_to', '');

    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,39}$' then
      raise exception 'Question keys are lower-case letters, numbers and underscores: "%"', coalesce(v_key, '');
    end if;

    if v_key = any (v_keys) then
      raise exception 'Two questions share the key "%"', v_key;
    end if;
    v_keys := v_keys || v_key;

    if coalesce(btrim(v_field ->> 'label'), '') = '' then
      raise exception 'Every question needs a label';
    end if;

    if coalesce(v_field ->> 'type', '') not in
       ('text', 'email', 'phone', 'number', 'textarea', 'select', 'checkbox') then
      raise exception 'Unknown question type "%"', coalesce(v_field ->> 'type', '');
    end if;

    if (v_field ->> 'type') = 'select'
       and coalesce(jsonb_array_length(coalesce(v_field -> 'options', '[]'::jsonb)), 0) = 0 then
      raise exception 'A "choose one" question needs some options';
    end if;

    /*
     * The whitelist. Everything a form is allowed to write onto a contact is
     * named here, and anything else lands in the submission's answers and
     * nowhere near a column. custom_fields.* is open because those keys belong
     * to the organization and carry no meaning to the system beyond scoring.
     */
    if v_maps <> '' then
      if v_maps not in ('first_name', 'last_name', 'full_name', 'email', 'phone',
                        'job_title', 'website', 'notes', 'company_name')
         and v_maps not like 'custom\_fields.%' then
        raise exception 'A question cannot fill "%"', v_maps;
      end if;

      if v_maps = any (v_targets) then
        raise exception 'Two questions both fill "%"', v_maps;
      end if;
      v_targets := v_targets || v_maps;

      if v_maps = 'email' then v_has_mail := true; end if;
    end if;
  end loop;

  if 'full_name' = any (v_targets)
     and ('first_name' = any (v_targets) or 'last_name' = any (v_targets)) then
    raise exception 'Ask for a full name or for first and last names, not both';
  end if;

  /*
   * Refused at publication rather than at creation, so a half-built form can be
   * saved. A live form with no email question collects answers that can never
   * become a contact, which is the one failure that looks like success.
   */
  if new.status = 'published' and not v_has_mail then
    raise exception 'A live form needs a question that fills the email address — without one a submission cannot become a contact';
  end if;

  if new.status = 'published' and new.consent_basis = 'express'
     and coalesce(btrim(new.consent_label), '') = '' then
    raise exception 'An express-consent form needs the words of its tick box — they are what the consent is evidence of';
  end if;

  return new;
end;
$$;

-- Revoked for the same reason every other trigger function here is: EXECUTE is
-- checked when a trigger is created, never when it fires, so a trigger function
-- needs no grant — and taking the grants away removes it from the REST surface.
revoke execute on function public.marketing_forms_check() from public, anon;

drop trigger if exists marketing_forms_check on public.marketing_forms;
create trigger marketing_forms_check
  before insert or update on public.marketing_forms
  for each row execute function public.marketing_forms_check();

-- -----------------------------------------------------------------------------
-- Row-level security
--
-- No grants to anon on either table. The public path reaches them through two
-- definer functions and nothing else.
-- -----------------------------------------------------------------------------
alter table public.marketing_forms            enable row level security;
alter table public.marketing_forms            force  row level security;
alter table public.marketing_form_submissions enable row level security;
alter table public.marketing_form_submissions force  row level security;

revoke all on public.marketing_forms            from anon;
revoke all on public.marketing_form_submissions from anon;

grant select, insert, update, delete on public.marketing_forms to authenticated;
/* Select only. Submissions are written by the public function and are not an
   authenticated user's to invent, edit or quietly tidy away — the whole value
   of the row is that nobody in the office touched it. */
grant select on public.marketing_form_submissions to authenticated;

drop policy if exists marketing_forms_select on public.marketing_forms;
create policy marketing_forms_select on public.marketing_forms
  for select to authenticated
  using (organization_id = (select public.current_org_id()));

drop policy if exists marketing_forms_write on public.marketing_forms;
create policy marketing_forms_write on public.marketing_forms
  for all to authenticated
  using (
    organization_id = (select public.current_org_id())
    and (select public.can_write_records())
  )
  with check (
    organization_id = (select public.current_org_id())
    and (select public.can_write_records())
  );

drop policy if exists marketing_form_submissions_select on public.marketing_form_submissions;
create policy marketing_form_submissions_select on public.marketing_form_submissions
  for select to authenticated
  using (organization_id = (select public.current_org_id()));

-- -----------------------------------------------------------------------------
-- Routing, addressed to an organization rather than to a session
--
-- next_assignee reads current_org_id(), which is exactly right for a contact
-- created by a person and useless to a form: the visitor has no session and
-- belongs to no tenant. The rule-walking moves into a function that is told
-- which organization it is working for, and next_assignee becomes a one-line
-- wrapper — so the routing rules a person configured are the same rules a form
-- obeys, rather than a second copy that drifts.
--
-- Definer, which also fixes something that was quietly broken: the round-robin
-- cursor lives on assignment_rules, and that table's write policy is
-- administrators only. A rep creating a contact updated no rows and the cursor
-- never moved, so round-robin handed every lead to the same person for anyone
-- who was not an admin. It moves now.
-- -----------------------------------------------------------------------------
create or replace function public.assign_owner_for_org(p_org uuid, p_source text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r         assignment_rules;
  v_user_id uuid;
begin
  if p_org is null then
    return null;
  end if;

  for r in
    select * from assignment_rules
    where organization_id = p_org and is_active
    order by priority, created_at
  loop
    if r.strategy = 'by_source' then
      if p_source is not null and lower(coalesce(r.source_match, '')) = lower(p_source) then
        return r.fixed_user_id;
      end if;

    elsif r.strategy = 'fixed_user' then
      return r.fixed_user_id;

    elsif r.strategy = 'round_robin' then
      -- Next active user after the cursor, wrapping around. Ordered by
      -- (created_at, id) because users created in one transaction share a
      -- timestamp, and a tie there parks the cursor on one person forever.
      select u.id into v_user_id
      from users u
      where u.organization_id = p_org and u.status = 'active'
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
        where u.organization_id = p_org and u.status = 'active'
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

create or replace function public.next_assignee(p_source text default null)
returns uuid
language sql
volatile
set search_path = public, pg_temp
as $$
  select public.assign_owner_for_org(public.current_org_id(), p_source);
$$;

revoke execute on function public.assign_owner_for_org(uuid, text) from public, anon;
grant execute on function public.assign_owner_for_org(uuid, text) to authenticated, service_role;
revoke execute on function public.next_assignee(text) from public, anon;
grant execute on function public.next_assignee(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Reading a form, as a stranger
--
-- Returns only what a visitor is entitled to see, which is why it builds an
-- object by hand instead of returning the row: the routing, the list, the owner
-- and the counters are the organization's business and none of the public's.
--
-- A draft returns nothing at all — a form that has not been published should
-- not be findable by guessing its address. A closed one returns its status and
-- its closing message and no questions, because the link may be printed on
-- something and 404 is a worse answer than "this has finished".
-- -----------------------------------------------------------------------------
create or replace function public.marketing_form_public(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'slug',              f.slug,
    'status',            f.status,
    'headline',          f.headline,
    'blurb',             f.blurb,
    'submit_label',      f.submit_label,
    'closed_message',    f.closed_message,
    'fields',            case when f.status = 'published' then f.fields else '[]'::jsonb end,
    'consent_basis',     f.consent_basis,
    'consent_label',     f.consent_label,
    'consent_required',  f.consent_required,
    'organization_name', o.name,
    'brand_color',       o.primary_color
  )
  from marketing_forms f
  join organizations o on o.id = f.organization_id
  where f.slug = lower(btrim(p_slug))
    and f.status in ('published', 'closed');
$$;

-- -----------------------------------------------------------------------------
-- Accepting one
--
-- The whole capture in one call, and one transaction with it. A submission that
-- half-happened — a contact with no submission behind it, or a consent record
-- with no contact — is worse than one that did not happen, because both halves
-- are supposed to be evidence of the other.
--
-- Refusals come back as { ok: false, error } rather than as exceptions. The
-- caller is a person filling in a form who needs to be told which answer is
-- missing, and an exception at this boundary is a 500 with the reason redacted.
-- Genuine faults still raise.
-- -----------------------------------------------------------------------------
create or replace function public.submit_marketing_form(
  p_slug    text,
  p_answers jsonb,
  p_consent boolean default false,
  p_meta    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_form       marketing_forms%rowtype;
  v_contact    contacts%rowtype;
  v_field      jsonb;
  v_key        text;
  v_label      text;
  v_type       text;
  v_maps       text;
  v_value      text;
  v_answers    jsonb := '[]'::jsonb;
  v_first      text := '';
  v_last       text := '';
  v_full       text := '';
  v_email      text := '';
  v_phone      text := '';
  v_title      text := '';
  v_website    text := '';
  v_note       text := '';
  v_company    text := '';
  v_custom     jsonb := '{}'::jsonb;
  v_space      integer;
  v_company_id uuid;
  v_contact_id uuid;
  v_owner      uuid;
  v_notify     uuid;
  v_ticked     boolean := coalesce(p_consent, false);
  v_grants     boolean := false;
  v_consent    text;
  v_conflict   boolean := false;
  v_blocked    boolean := false;
  v_submission uuid;
  v_display    text;
begin
  select * into v_form
  from marketing_forms
  where slug = lower(btrim(coalesce(p_slug, '')));

  if not found or v_form.status <> 'published' then
    return jsonb_build_object('ok', false, 'error', 'This form is not accepting responses.');
  end if;

  if jsonb_typeof(coalesce(p_answers, 'null'::jsonb)) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'That submission could not be read.');
  end if;

  -- ---------------------------------------------------------------------------
  -- Read the answers through the form's own question list
  --
  -- Driven by the form rather than by what arrived, so a key nobody asked for
  -- is not stored, not mapped and not echoed back. It is also what freezes the
  -- labels into the submission.
  -- ---------------------------------------------------------------------------
  for v_field in select value from jsonb_array_elements(v_form.fields) loop
    v_key   := v_field ->> 'key';
    v_label := v_field ->> 'label';
    v_type  := v_field ->> 'type';
    v_maps  := coalesce(v_field ->> 'maps_to', '');

    if v_type = 'checkbox' then
      v_value := case
        when lower(coalesce(p_answers ->> v_key, '')) in ('true', 'on', 'yes', '1') then 'Yes'
        else 'No'
      end;
    else
      -- Capped rather than refused: a pasted signature block in a message box
      -- is not an attack, and losing the lead over it would be the wrong trade.
      v_value := left(btrim(coalesce(p_answers ->> v_key, '')), 2000);
    end if;

    if coalesce(v_field ->> 'required', 'false') = 'true'
       and (v_value = '' or (v_type = 'checkbox' and v_value = 'No')) then
      return jsonb_build_object('ok', false, 'error', format('%s is needed.', v_label));
    end if;

    if v_value <> '' then
      v_answers := v_answers || jsonb_build_array(
        jsonb_build_object('key', v_key, 'label', v_label, 'value', v_value)
      );
    end if;

    if v_maps = 'first_name'   then v_first   := v_value; end if;
    if v_maps = 'last_name'    then v_last    := v_value; end if;
    if v_maps = 'full_name'    then v_full    := v_value; end if;
    if v_maps = 'email'        then v_email   := lower(v_value); end if;
    if v_maps = 'phone'        then v_phone   := v_value; end if;
    if v_maps = 'job_title'    then v_title   := v_value; end if;
    if v_maps = 'website'      then v_website := v_value; end if;
    if v_maps = 'notes'        then v_note    := v_value; end if;
    if v_maps = 'company_name' then v_company := v_value; end if;

    if v_maps like 'custom\_fields.%' and v_value <> '' then
      v_custom := v_custom || jsonb_build_object(substring(v_maps from 15), v_value);
    end if;
  end loop;

  /*
   * An address is not optional even when the question is not marked required.
   * Without one there is no contact to make and no way to answer the person —
   * the submission would be an anonymous note in a table nobody reads.
   */
  if v_email = '' then
    return jsonb_build_object('ok', false, 'error', 'An email address is needed.');
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'error', 'That email address does not look right.');
  end if;

  if v_form.consent_basis = 'express' and v_form.consent_required and not v_ticked then
    return jsonb_build_object('ok', false, 'error', 'Please tick the box to continue.');
  end if;

  -- One name field, split on the first space: "Mary Jane Watson" is Mary, then
  -- Jane Watson. Guessing the other way round is wrong far more often.
  if v_full <> '' then
    v_space := position(' ' in v_full);
    if v_space = 0 then
      v_first := v_full;
    else
      v_first := left(v_full, v_space - 1);
      v_last  := btrim(substring(v_full from v_space + 1));
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- Who this is
  -- ---------------------------------------------------------------------------
  select * into v_contact
  from contacts
  where organization_id = v_form.organization_id
    and lower(email) = v_email
    and deleted_at is null
    and duplicate_of_id is null
  order by created_at
  limit 1;

  select exists (
    select 1 from email_suppressions s
    where s.organization_id = v_form.organization_id
      and lower(s.email) = v_email
  ) into v_blocked;

  v_grants := (v_form.consent_basis = 'express' and v_ticked)
              or v_form.consent_basis = 'implied';

  /*
   * What the form is willing to grant, against what the record already says.
   * An unsubscribe and a suppression both outrank a fresh tick box; see the
   * note on consent_conflict.
   */
  if v_grants and (v_blocked or coalesce(v_contact.marketing_consent, '') = 'unsubscribed') then
    v_conflict := true;
    v_consent  := null;
  elsif v_form.consent_basis = 'express' and v_ticked then
    v_consent := 'express';
  elsif v_form.consent_basis = 'implied'
        and coalesce(v_contact.marketing_consent, 'none') = 'none' then
    -- Implied never displaces express: it is the weaker basis and it expires.
    v_consent := 'implied';
  else
    v_consent := null;
  end if;

  if v_company <> '' then
    select id into v_company_id
    from companies
    where organization_id = v_form.organization_id
      and lower(name) = lower(v_company)
      and deleted_at is null
    limit 1;

    if v_company_id is null then
      insert into companies (organization_id, name)
      values (v_form.organization_id, v_company)
      returning id into v_company_id;
    end if;
  end if;

  if v_contact.id is null then
    v_owner := coalesce(
      v_form.owner_id,
      public.assign_owner_for_org(v_form.organization_id, v_form.source)
    );

    insert into contacts (
      organization_id, first_name, last_name, email, phone, job_title, website,
      notes, company_id, owner_id, source, lifecycle_stage, custom_fields,
      marketing_consent, consent_source, consent_at
    )
    values (
      v_form.organization_id, v_first, v_last, v_email,
      nullif(v_phone, ''), nullif(v_title, ''), nullif(v_website, ''),
      nullif(v_note, ''), v_company_id, v_owner,
      coalesce(nullif(v_form.source, ''), v_form.name),
      v_form.lifecycle_stage, v_custom,
      coalesce(v_consent, 'none'),
      case when v_consent is null then null else 'Form: ' || v_form.name end,
      case when v_consent is null then null else now() end
    )
    returning id into v_contact_id;
  else
    v_contact_id := v_contact.id;
    v_owner      := v_contact.owner_id;

    /*
     * Blanks only. A returning visitor typing "Bob" must not overwrite the
     * "Robert Nkemelu, VP Procurement" a rep corrected by hand last week — the
     * form is one input among several and it is not the authoritative one. What
     * they typed is kept verbatim on the submission either way.
     *
     * Consent is the exception, because a newer, stronger basis genuinely does
     * replace an older one, and the submission is its evidence.
     */
    update contacts set
      first_name      = case when btrim(first_name) = '' then v_first else first_name end,
      last_name       = case when btrim(last_name) = ''  then v_last  else last_name end,
      phone           = coalesce(phone, nullif(v_phone, '')),
      job_title       = coalesce(job_title, nullif(v_title, '')),
      website         = coalesce(website, nullif(v_website, '')),
      notes           = coalesce(notes, nullif(v_note, '')),
      company_id      = coalesce(company_id, v_company_id),
      source          = coalesce(source, nullif(v_form.source, ''), v_form.name),
      -- Existing keys win: v_custom supplies only what the record lacks.
      custom_fields   = v_custom || custom_fields,
      marketing_consent = coalesce(v_consent, marketing_consent),
      consent_source  = case when v_consent is null then consent_source
                             else 'Form: ' || v_form.name end,
      consent_at      = case when v_consent is null then consent_at else now() end
    where id = v_contact_id;
  end if;

  -- ---------------------------------------------------------------------------
  -- The receipt
  -- ---------------------------------------------------------------------------
  insert into marketing_form_submissions (
    organization_id, form_id, contact_id, answers, email, name,
    consent_given, consent_label, consent_conflict,
    page_url, referrer, utm, user_agent
  )
  values (
    v_form.organization_id, v_form.id, v_contact_id, v_answers, v_email,
    nullif(btrim(v_first || ' ' || v_last), ''),
    v_ticked and v_form.consent_basis = 'express',
    case when v_form.consent_basis = 'express' then v_form.consent_label end,
    v_conflict,
    left(p_meta ->> 'page_url', 2000),
    left(p_meta ->> 'referrer', 2000),
    case when jsonb_typeof(coalesce(p_meta -> 'utm', 'null'::jsonb)) = 'object'
         then p_meta -> 'utm' else '{}'::jsonb end,
    left(p_meta ->> 'user_agent', 500)
  )
  returning id into v_submission;

  /*
   * Onto the list, unless the consent record says otherwise. Adding somebody
   * who has unsubscribed would not send them anything — the send loop checks
   * again — but a list that quietly holds people who may not be mailed is a
   * list whose count is a lie.
   */
  if v_form.list_id is not null and not v_conflict then
    insert into email_list_members (organization_id, list_id, contact_id)
    values (v_form.organization_id, v_form.list_id, v_contact_id)
    on conflict do nothing;
  end if;

  update marketing_forms
  set submission_count   = submission_count + 1,
      last_submission_at = now()
  where id = v_form.id;

  v_display := coalesce(nullif(btrim(v_first || ' ' || v_last), ''), v_email);

  /*
   * On the timeline, not only in a submissions table. The rep who has to ring
   * this person looks at the contact, and a lead whose arrival is only recorded
   * on a marketing screen is a lead that gets rung a week late.
   *
   * external_id is the submission, so the unique index makes a replay a no-op.
   */
  insert into activities (
    organization_id, type, related_to_type, related_to_id, owner_id,
    subject, body, external_source, external_id, occurred_at
  )
  values (
    v_form.organization_id, 'note', 'contact', v_contact_id, v_owner,
    format('Submitted the form “%s”', v_form.name),
    (select string_agg(format('**%s:** %s', a ->> 'label', a ->> 'value'), E'\n\n')
     from jsonb_array_elements(v_answers) a),
    'marketing_form', v_submission::text, now()
  )
  on conflict do nothing;

  v_notify := coalesce(v_form.notify_user_id, v_owner);

  if v_notify is not null then
    insert into notifications (organization_id, user_id, kind, title, body, link)
    select v_form.organization_id, u.id, 'form_submission',
           format('New submission: %s', v_form.name),
           format('%s just filled in %s.', v_display, v_form.name),
           '/contacts/' || v_contact_id
    from users u
    where u.id = v_notify
      and u.organization_id = v_form.organization_id
      and u.status = 'active';
  end if;

  return jsonb_build_object(
    'ok', true,
    'message', v_form.success_message,
    'redirect_url', v_form.redirect_url
  );
end;
$$;

revoke execute on function public.marketing_form_public(text) from public;
revoke execute on function public.submit_marketing_form(text, jsonb, boolean, jsonb) from public;

/*
 * anon on purpose, and the only two functions on these tables that carry it.
 * The person filling in the form has no account and must not need one — which
 * is the same argument the unsubscribe pair makes, and the same shape: a
 * definer function narrow enough to be the whole public surface.
 */
grant execute on function public.marketing_form_public(text)
  to anon, authenticated, service_role;
grant execute on function public.submit_marketing_form(text, jsonb, boolean, jsonb)
  to anon, authenticated, service_role;
