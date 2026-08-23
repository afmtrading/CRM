-- =============================================================================
-- An inactive organization is actually switched off
--
-- organizations.status has existed since the first migration — `org_status` is
-- an enum of 'active' and 'inactive', the column is not null, and it defaults
-- to active. Nothing has ever read it. No policy, no function, no line of
-- application code. Setting an organization inactive changed a value and
-- nothing else: its people signed in exactly as before and saw exactly what
-- they saw before.
--
-- That is worse than not having the column. A field that looks like a switch
-- and is not one gets used as though it were — an account is "suspended", the
-- row says inactive, everybody moves on, and the account is still fully live.
--
-- WHERE THIS GOES
--
-- In current_org_id(), which is the answer to "which organization is this
-- session", and which every row-level policy in the schema consults. An
-- inactive organization resolves to null there, and null matches no row on any
-- table — so the enforcement is one edit in one function rather than a
-- condition repeated across a hundred policies that could each forget it.
--
-- The application layer gets the same check independently, in
-- getSessionContext, so somebody is sent to /no-access with a sentence that
-- explains it rather than to an empty CRM that appears to have lost their
-- data. That is the same two-layer arrangement the tenancy rule already uses:
-- the interface refuses politely, and the database refuses regardless.
--
-- WHAT IS DELIBERATELY UNAFFECTED
--
-- service_role bypasses RLS, so the cron drains and the ingest endpoint are
-- untouched. That is correct for the sending side — a campaign already in
-- flight when an account is suspended should finish or be stopped on purpose,
-- not half-deliver because a policy changed underneath it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The session helpers
--
-- Both gain the same join. current_user_org_ids() is the Phase 3 list and
-- current_org_id() is the Phase 1 answer; leaving either one out would mean the
-- rule held in some policies and not others.
-- -----------------------------------------------------------------------------
create or replace function public.current_user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.organization_id
  from public.users u
  join public.organizations o on o.id = u.organization_id
  where u.auth_provider_id = auth.uid()
    and u.status = 'active'
    and o.status = 'active';
$$;

create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with claimed as (
    -- nullif before the cast: an absent or blank claims setting is normal for
    -- an unauthenticated request, and ''::jsonb raises.
    select nullif(
      coalesce(
        nullif(current_setting('request.jwt.claims', true), '')::jsonb
          -> 'app_metadata' ->> 'active_organization_id',
        ''
      ), ''
    )::uuid as id
  )
  select coalesce(
    (select c.id from claimed c
      where c.id is not null
        and exists (
          select 1
          from public.users u
          join public.organizations o on o.id = u.organization_id
          where u.auth_provider_id = auth.uid()
            and u.status = 'active'
            and o.status = 'active'
            and u.organization_id = c.id
        )),
    (select u.organization_id
      from public.users u
      join public.organizations o on o.id = u.organization_id
      where u.auth_provider_id = auth.uid()
        and u.status = 'active'
        and o.status = 'active'
      order by u.created_at
      limit 1)
  );
$$;

comment on function public.current_org_id() is
  'The one organization this session is bound to, or null — for an unauthenticated caller, a user who is not active, or an organization that is not active.';

-- -----------------------------------------------------------------------------
-- Why somebody was turned away
--
-- /no-access has to tell the difference between "you have not been invited yet"
-- and "your organization is suspended", because the first sentence sends people
-- to an administrator and the second sends them to the person who suspended it.
-- Getting that wrong wastes somebody's afternoon.
--
-- It cannot work it out from the tables: with current_org_id() null, the user's
-- own row is unreadable through the policies, which is the point. So this
-- answers the one question, as definer, about the caller and nobody else.
--
-- It reports only on rows belonging to auth.uid(), and it returns a reason
-- rather than a name or an id — somebody turned away learns why they were
-- turned away and nothing about the organization that turned them away.
-- -----------------------------------------------------------------------------
create or replace function public.access_denied_reason()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth.uid() is null then 'not_signed_in'
    when exists (
      select 1 from public.users u
      join public.organizations o on o.id = u.organization_id
      where u.auth_provider_id = auth.uid()
        and u.status = 'active'
        and o.status = 'active'
    ) then 'none'
    when exists (
      select 1 from public.users u
      join public.organizations o on o.id = u.organization_id
      where u.auth_provider_id = auth.uid()
        and u.status = 'active'
        and o.status <> 'active'
    ) then 'organization_inactive'
    when exists (
      select 1 from public.users u
      where u.auth_provider_id = auth.uid()
        and u.status <> 'active'
    ) then 'user_not_active'
    else 'no_membership'
  end;
$$;

revoke execute on function public.access_denied_reason() from public, anon;
grant execute on function public.access_denied_reason() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- And the public forms stop too
--
-- Both functions belong to the suspended organization rather than to a session,
-- so current_org_id() has nothing to say about them — they would have carried on
-- collecting leads for an account whose staff could no longer sign in to read
-- them. A closed account's front door should be closed.
--
-- A submission is refused in the same words a closed form uses, because from
-- the visitor's side that is exactly what has happened, and the state of
-- somebody's account is not a stranger's business.
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
    and f.status in ('published', 'closed')
    and o.status = 'active';
$$;

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
  /*
   * The organization has to be live too. Added in 20260277000000: a suspended
   * account's forms stop collecting, and the refusal is worded exactly like a
   * closed form's, because the state of somebody's account is not a stranger's
   * business.
   */
  select f.* into v_form
  from marketing_forms f
  join organizations o on o.id = f.organization_id
  where f.slug = lower(btrim(coalesce(p_slug, '')))
    and o.status = 'active';

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
