import Link from "next/link";
import { notFound } from "next/navigation";

import { requireSession, scoped, firstRow } from "@/lib/tenancy";
import { contactName, formatDay } from "@/lib/format";
import { DateTime } from "@/components/date-time";
import { Money } from "@/components/money";
import {
  CONSENT_LABELS,
  OVERRIDE_OPTIONS,
  blockedLabel,
  impliedConsentExpiry,
  overrideLabel,
} from "@/lib/consent";
import {
  COMPANY_CARDS,
  CONTACT_CARDS,
  daysUntilBirthday,
  optionsForField,
  renderMarkdown,
  safeUrl,
  socialUrl,
} from "@/lib/field-options";
import type {
  ActivityRow,
  ContactCard,
  ContactLink,
  ContactRow,
  CustomFieldDefinitionRow,
  DealRow,
  FieldOptionRow,
  TagRow,
  UserRow,
} from "@/lib/database.types";
import {
  ActivityComposer,
  ActivityTimeline,
} from "@/components/activity-timeline";
import {
  DealStatusBadge,
  LifecycleBadge,
  PageHeader,
  ScoreMeter,
  Section,
} from "@/components/ui";
import { CalendarIcon } from "@/components/icons";
import { TagPicker } from "@/components/tag-picker";
import {
  CardLink,
  ContactMethod,
  CustomFieldValues,
  Empty,
  ExternalLink,
  Field,
  FieldRow,
  OptionBadge,
  OptionBadges,
  optionColor,
} from "@/components/contact-cards";

import { ActionForm, SubmitButton } from "@/components/action-form";

import {
  deleteContact,
  setContactHidden,
  mergeContactsAction,
  setContactTags,
  setMailableOverride,
} from "../actions";

/*
 * Never served from the route cache.
 *
 * These read per-request, per-tenant data behind an authenticated session, and
 * the App Router will happily hand back a previously rendered page otherwise —
 * which shows up as a deploy that went out and a screen that did not change.
 * The sales and invoice screens have said this since they were written; the
 * rest of the record pages were relying on it not happening.
 */
export const dynamic = 'force-dynamic'

export default async function ContactDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ merged?: string }>;
}) {
  const { id } = await params;
  const { merged } = await searchParams;
  const context = await requireSession();

  /*
   * The company comes back with the fields the Company card mirrors, so that
   * card is a read of the business rather than a second copy of it — edit the
   * company and the contact page follows.
   */
  const contact = await firstRow<
    ContactRow & {
      companies:
        | {
            id: string;
            name: string;
            domain: string | null;
            specialty_market: string[];
            stock_type: string[];
            customer_type: string[];
            custom_fields: Record<string, unknown>;
          }
        | null;
    }
  >(
    scoped(context, "contacts")
      .select(
        "*, companies(id, name, domain, specialty_market, stock_type, customer_type, custom_fields)",
      )
      .eq("id", id)
      .maybeSingle(),
  );

  if (!contact) notFound();

  const [
    { data: activities },
    { data: deals },
    { data: users },
    { data: tags },
    { data: contactTags },
    { data: fieldOptions },
    { data: customFieldDefs },
    { data: mailability },
    { data: duplicates },
  ] = await Promise.all([
    scoped(context, "activities")
      .select("*")
      .eq("related_to_type", "contact")
      .eq("related_to_id", id)
      .order("occurred_at", { ascending: false })
      .limit(100),
    scoped(context, "deals")
      .select("*, stages(name)")
      .eq("contact_id", id)
      .order("created_at", { ascending: false }),
    scoped(context, "users").select("*").order("name"),
    scoped(context, "tags").select("*").order("name"),
    scoped(context, "contact_tags").select("tag_id").eq("contact_id", id),
    scoped(context, "field_options").select("*").order("order"),
    // Both entities in one round trip: the contact's own definitions, and the
    // company's, which the Company card below renders.
    scoped(context, "custom_field_definitions")
      .select("*")
      .in("entity_type", ["contact", "company"])
      .order("order"),
    scoped(context, "contact_mailability")
      .select("blocked_reason")
      .eq("contact_id", id)
      .maybeSingle(),
    context.supabase.rpc("find_duplicate_contacts", {
      p_email: contact.email,
      p_first_name: contact.first_name,
      p_last_name: contact.last_name,
      p_phone: contact.phone,
      p_exclude_id: contact.id,
    }),
  ]);


  const duplicateList = (duplicates ?? []) as ContactRow[];
  const userList = (users ?? []) as UserRow[];
  const tagList = (tags ?? []) as TagRow[];
  const selectedTagIds = new Set(
    ((contactTags ?? []) as { tag_id: string }[]).map((t) => t.tag_id),
  );
  const dealRows = (deals ?? []) as (DealRow & {
    stages: { name: string } | null;
  })[];

  const options = (fieldOptions ?? []) as FieldOptionRow[];
  /*
   * Scoped to the record the field belongs to, not just the key. This page
   * reads both lists — the contact's own fields and the company's, which the
   * Company card below mirrors — and `priority` is a list on contacts, another
   * on companies and another on products. Matching the key alone drew all
   * three, so a badge could take another record type's colour.
   */
  const optionsFor = (key: string) => optionsForField(options, "contact", key);
  const companyOptionsFor = (key: string) => optionsForField(options, "company", key);

  const userName = (userId: string | null) => {
    if (!userId) return null;
    const user = userList.find((candidate) => candidate.id === userId);
    return user ? user.name || user.email : null;
  };

  // Custom fields are grouped by the card their admin assigned them to.
  const allCustomFields = (customFieldDefs ?? []) as CustomFieldDefinitionRow[];
  const customFields = allCustomFields.filter(
    (field) => field.entity_type === "contact",
  );
  const customByCard = (card: ContactCard) =>
    customFields.filter((field) => field.card === card);
  const customValues = (contact.custom_fields ?? {}) as Record<string, unknown>;

  /*
   * The Company Rating card, mirrored from the business. Anything an admin
   * files under the company's own Company Rating card appears here too, which
   * is the point of mirroring rather than listing — add one there and this
   * card grows without being edited.
   *
   * Only what is genuinely a custom field, though. This once said stock type
   * was one, and it is a column; nothing rendered it and the card quietly
   * showed a company's merchandise and type with the condition of its goods
   * missing. Columns have to be named here the way market and company type
   * are, so a new one is a change to this file and not an assumption.
   */
  const company = contact.companies;
  const companyCustomFields = allCustomFields.filter(
    (field) => field.entity_type === "company" && field.card === "rating",
  );
  const companyCustomValues = (company?.custom_fields ?? {}) as Record<
    string,
    unknown
  >;

  const name = contactName(contact);
  const emailBlock = blockedLabel(
    (mailability as { blocked_reason: string | null } | null)?.blocked_reason as never,
  );
  const consentExpiry = impliedConsentExpiry(contact.marketing_consent, contact.consent_at);
  const manualOverride = overrideLabel(contact.mailable_override);
  const notesHtml = renderMarkdown(contact.notes);
  const untilBirthday = daysUntilBirthday(contact.birthday);
  const extraLinks = Array.isArray(contact.links)
    ? (contact.links as ContactLink[])
    : [];

  // The Digital card falls back to the company's domain, so a contact inherits
  // their employer's website without it being typed twice.
  const companyWebsite = safeUrl(
    contact.website ?? contact.companies?.domain ?? null,
  );

  return (
    <>
      <PageHeader
        title={name}
        /*
          The company under the name, and a link to it. The job title used to
          sit here and now sits beside the name inside the card, where it is
          labelled — under the title it was an unlabelled line of text that
          could be read as part of the name.
        */
        description={
          contact.companies ? (
            <CardLink href={`/companies/${contact.companies.id}`}>
              {contact.companies.name}
            </CardLink>
          ) : undefined
        }
        actions={
          <>
            {context.canWrite && (
              <Link href={`/contacts/${id}/edit`} className="btn-secondary">
                Edit
              </Link>
            )}
            {/* Deleting is reversible now — the record is stamped, leaves
                everyone's view but an administrator's, and can be restored. */}
            {context.canWrite && (
              <form action={deleteContact}>
                <input type="hidden" name="id" value={id} />
                <button type="submit" className="btn-danger">
                  Delete
                </button>
              </form>
            )}
            {/* Only offered to somebody who can see hidden records, which is
                the same group that may hide them — see 20260237000000 for why
                those are one capability rather than two. */}
            {context.canSeeHidden && (
              <ActionForm action={setContactHidden}>
                <input type="hidden" name="id" value={id} />
                <input
                  type="hidden"
                  name="hidden"
                  value={contact.hidden ? "false" : "true"}
                />
                <SubmitButton className="btn-secondary" pendingLabel="Working…">
                  {contact.hidden ? "Unhide" : "Hide"}
                </SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />

      {contact.hidden && (
        <p className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
          <strong className="font-semibold">Hidden.</strong> Nobody without
          &ldquo;See hidden records&rdquo; can find this contact, including
          whoever owns it. Its deals and activities stay visible with the
          contact behind them unreadable.
        </p>
      )}

      {merged && (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          Contacts merged. Deals and activities from the duplicate now live
          here.
        </p>
      )}

      {contact.duplicate_of_id && (
        <p className="mb-4 rounded-xl border border-slate-300 bg-slate-100 px-3.5 py-2.5 text-sm text-slate-700">
          This record was merged into{" "}
          <Link
            href={`/contacts/${contact.duplicate_of_id}`}
            className="font-medium text-brand-700 hover:underline"
          >
            another contact
          </Link>
          . It is kept so existing links still resolve.
        </p>
      )}

      {untilBirthday !== null && untilBirthday <= 7 && (
        <p className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
          <CalendarIcon className="h-4 w-4 shrink-0" />
          {untilBirthday === 0
            ? `It is ${name}'s birthday today.`
            : `${name}'s birthday is in ${untilBirthday} day${untilBirthday === 1 ? "" : "s"}.`}
        </p>
      )}

      {/* Merge flow (PRD 6.2): fold a duplicate into this record. */}
      {duplicateList.length > 0 && !contact.duplicate_of_id && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Possible duplicate{duplicateList.length === 1 ? "" : "s"} of this
            contact
          </p>
          <ul className="mt-2 space-y-2">
            {duplicateList.map((duplicate) => (
              <li
                key={duplicate.id}
                className="flex flex-wrap items-center gap-3 text-sm"
              >
                <Link
                  href={`/contacts/${duplicate.id}`}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {contactName(duplicate)}
                </Link>
                <span className="text-slate-500">
                  {duplicate.email ?? duplicate.phone ?? ""}
                </span>
                <form action={mergeContactsAction}>
                  <input type="hidden" name="target_id" value={id} />
                  <input type="hidden" name="source_id" value={duplicate.id} />
                  <button type="submit" className="btn-secondary py-1">
                    Merge into this contact
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Three regions rather than two columns, the same as a company: the
        record, the sidebar beside it, and everything the record accumulates
        underneath. The record used to span the whole page with a band of empty
        space to its right, which is where Influence now starts.
      */}
      {/*
        The row template is load-bearing. Without it the sidebar spans two rows
        and the browser hands its extra height to both of them equally, which
        stretched row one and left a band of blank space between the record and
        the deals below it. `auto` pins row one to the record's own height and
        `1fr` sends the overflow to row two, where it is absorbed.
      */}
      {/*
        Two stacked columns on a wide screen; one column, in reading order, on a
        narrow one.

        The wrappers are `display: contents` below lg, which dissolves them so
        every card becomes a direct flex child of this container and can be
        ordered individually. Without that, a narrow screen could only ever
        stack one whole column after the other — which is why the details a
        record is actually read for used to sit below everything else.

        Cards are ordered visually rather than in the markup, so the tab order
        still follows the source. They are landmarks with headings rather than a
        sequence to step through, which makes that trade acceptable here.

        A card added here without an order class defaults to 0 and lands at the
        very top. Give every new card one.
      */}
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-3 lg:grid-rows-[auto_1fr] lg:items-start">
        {/* Contact details leads — it is what someone opened the page for. */}
        <div className="contents lg:block lg:col-span-2 lg:col-start-1 lg:row-start-1">
          {/*
            Owner sits in this card's header rather than beside the page title
            or down in Additional info. Who owns the relationship belongs with
            who the person is.

            One line, label and name together. Stacked, a two-line block in the
            corner of a header read as a heading of its own rather than as one
            small fact about the card underneath it.
          */}
          <Section
            title={CONTACT_CARDS[0].label}
            className="order-1"
            actions={
              <p className="min-w-0 truncate text-sm text-slate-500">
                Owner:{" "}
                <span className="font-semibold text-slate-900">
                  {userName(contact.owner_id) ?? "—"}
                </span>
              </p>
            }
          >
            {/*
              Every fact in this card is labelled, the name included. It used to
              lead as bold text with the job title grey underneath, which said
              what the two were but not which was which — and repeated a name
              the page title already carries two lines above.

              Paired left to right: who they are and what they do, then the two
              ways to write to them, then the two ways to call. The company is
              not here at all; it is under the page title, where it belongs to
              the person rather than sitting in a list of their details.
            */}
            <dl className="divide-y divide-slate-100">
              <FieldRow>
                <Field label="Name">{name}</Field>
                <Field label="Job title">{contact.job_title || <Empty />}</Field>
              </FieldRow>
              <FieldRow>
                <Field label="Primary email">
                  <ContactMethod value={contact.email} kind="email" label={name} />
                </Field>
                <Field label="Secondary email">
                  <ContactMethod
                    value={contact.secondary_email}
                    kind="email"
                    label={name}
                  />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field label="Mobile phone">
                  <ContactMethod value={contact.phone} kind="phone" label={name} />
                </Field>
                <Field label="Office phone">
                  <ContactMethod value={contact.office_phone} kind="phone" label={name} />
                </Field>
              </FieldRow>
              <CustomFieldValues
                fields={customByCard("details")}
                values={customValues}
                fieldOptions={options}
              />
            </dl>
          </Section>
        </div>

        {/*
          Deals sit directly under the record, ahead of the activity feed. What
          this person is involved in selling is usually the reason their page
          was opened, and it was below the whole feed.

          That held on a wide screen only. The grid puts this column under the
          record, but the order class read `order-9`, so a phone — where the
          wrappers dissolve and the order classes are the whole layout — showed
          Deals ninth, behind Additional info, Record history and Email consent.
          Sixth now: after the cards that say who this person is, ahead of the
          ones that say how the record was kept. The same place a company gives
          its own Deals card.
        */}
        <div className="contents lg:block lg:space-y-5 lg:col-span-2 lg:col-start-1 lg:row-start-2">
          <Section
            title="Deals"
            className="order-6"
            actions={
              <Link
                href={`/deals/new?contact_id=${id}`}
                className="btn-secondary py-1"
              >
                New deal
              </Link>
            }
          >
            {dealRows.length === 0 ? (
              <p className="text-sm text-slate-500">
                No deals linked to this contact.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Deal</th>
                      <th>Stage</th>
                      <th>Value</th>
                      <th>Status</th>
                      <th>Expected close</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dealRows.map((deal) => (
                      <tr key={deal.id}>
                        <td>
                          <Link
                            href={`/deals/${deal.id}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {deal.name}
                          </Link>
                        </td>
                        <td>{deal.stages?.name ?? "—"}</td>
                        <td>
                          <Money
                            value={Number(deal.value ?? 0)}
                            currency={deal.currency}
                            amountClassName="font-medium"
                          />
                        </td>
                        <td>
                          <DealStatusBadge status={deal.status} />
                        </td>
                        <td>{formatDay(deal.expected_close_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Activity" className="order-10">
            <ActivityComposer
              relatedToType="contact"
              relatedToId={id}
              users={userList}
              currentUserId={context.user.id}
            />
            <div className="mt-4 border-t border-slate-100 pt-2">
              <ActivityTimeline
                activities={(activities ?? []) as ActivityRow[]}
                users={userList}
                returnTo={`/contacts/${id}`}
                emptyMessage="No calls, emails, meetings, notes or tasks logged for this contact yet."
              />
            </div>
          </Section>
        </div>

        {/*
          The sidebar starts level with the record on a wide screen, and comes
          straight after it on a narrow one — ahead of the activity feed, which
          is long and is not what most visits are for. Influence leads it: how
          much weight this person carries is the first thing worth knowing
          about them after who they are.
        */}
        <div className="contents lg:block lg:space-y-5 lg:col-start-3 lg:row-span-2 lg:row-start-1">
          <Section title={CONTACT_CARDS[1].label} className="order-2">
            <dl className="divide-y divide-slate-100">
              <FieldRow columns={1}>
                <Field label="Role type">
                  <OptionBadges values={contact.role_type} options={optionsFor("role_type")} />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field label="Priority">
                  {contact.priority ? (
                    <OptionBadge
                      value={contact.priority}
                      color={optionColor(optionsFor("priority"), contact.priority)}
                    />
                  ) : (
                    <Empty />
                  )}
                </Field>
                <Field label="Credibility">
                  {contact.credibility ? (
                    <OptionBadge
                      value={contact.credibility}
                      color={optionColor(optionsFor("credibility"), contact.credibility)}
                    />
                  ) : (
                    <Empty />
                  )}
                </Field>
              </FieldRow>
              <CustomFieldValues
                fields={customByCard("influence")}
                values={customValues}
                fieldOptions={options}
              />
            </dl>
          </Section>

          <Section title="Tags" className="order-3">
            {/*
              The same control the contact form carries, so tagging looks the
              same wherever it is done. Here it saves itself once the clicking
              stops; there it rides along with the record's other fields, which
              is why autoSubmit is set on one and not the other.
            */}
            <form action={setContactTags} className="space-y-3">
              <input type="hidden" name="contact_id" value={id} />
              <TagPicker
                tags={tagList}
                selected={selectedTagIds}
                canManage={context.isAdmin}
                canCreate={context.canWrite}
                autoSubmit
              />
            </form>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title={CONTACT_CARDS[3].label} className="order-5">
            <dl className="divide-y divide-slate-100">
              <FieldRow columns={1}>
                <Field label="Company website">
                  <ExternalLink url={companyWebsite} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="LinkedIn">
                  <ExternalLink url={socialUrl("linkedin", contact.linkedin)} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Facebook">
                  <ExternalLink url={socialUrl("facebook", contact.facebook)} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Instagram">
                  <ExternalLink url={socialUrl("instagram", contact.instagram)} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="TikTok">
                  <ExternalLink url={socialUrl("tiktok", contact.tiktok)} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="X (Twitter)">
                  <ExternalLink url={socialUrl("x_twitter", contact.x_twitter)} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="YouTube">
                  <ExternalLink url={socialUrl("youtube", contact.youtube)} />
                </Field>
              </FieldRow>
              <CustomFieldValues
                fields={customByCard("digital")}
                values={customValues}
                fieldOptions={options}
                columns={1}
              />

              {extraLinks.length > 0 && (
                <FieldRow columns={1}>
                  <div>
                    <dt className="text-xs font-medium text-slate-500">
                      Other links
                    </dt>
                    <dd className="mt-1 space-y-1 text-sm">
                      {extraLinks.map((link, index) => (
                        <div key={`${link.url}-${index}`}>
                          <ExternalLink
                            url={safeUrl(link.url)}
                            label={link.label || undefined}
                          />
                        </div>
                      ))}
                    </dd>
                  </div>
                </FieldRow>
              )}
            </dl>
          </Section>

          {/*
            What kind of business this person works for. Read from the company
            rather than stored again on the contact, so the two can never
            disagree — and shown only when there is one, since a card of dashes
            says nothing that the empty Company field above has not said.
          */}
          {company && (
            <Section
              title={COMPANY_CARDS[3].label}
              className="order-4"
              actions={
                <CardLink href={`/companies/${company.id}`}>
                  {company.name}
                </CardLink>
              }
            >
              <dl className="divide-y divide-slate-100">
                <FieldRow columns={1}>
                  <Field label="Market">
                    <OptionBadges
                      values={company.specialty_market}
                      options={companyOptionsFor("specialty_market")}
                    />
                  </Field>
                </FieldRow>
                {/*
                  Between the two it belongs between: what category of goods a
                  business deals in, then what condition they arrive in, then
                  what kind of business it is. The company's own card orders
                  merchandise and stock type the same way round.
                */}
                <FieldRow columns={1}>
                  <Field label="Stock type">
                    <OptionBadges
                      values={company.stock_type}
                      options={companyOptionsFor("stock_type")}
                    />
                  </Field>
                </FieldRow>
                <FieldRow columns={1}>
                  <Field label="Company type">
                    <OptionBadges
                      values={company.customer_type}
                      options={companyOptionsFor("customer_type")}
                    />
                  </Field>
                </FieldRow>
                <CustomFieldValues
                  fields={companyCustomFields}
                  values={companyCustomValues}
                  fieldOptions={options}
                  columns={1}
                />
              </dl>
            </Section>
          )}

          {/* ---------------------------------------------------------------- */}
          <Section title={CONTACT_CARDS[2].label} className="order-7">
            <dl className="divide-y divide-slate-100">
              {/* Owner is in the Contact details header now, not repeated here. */}
              <FieldRow columns={1}>
                <Field label="Lead score">
                  <ScoreMeter score={contact.lead_score} />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field label="Source">{contact.source || <Empty />}</Field>
                <Field label="Lifecycle stage">
                  <LifecycleBadge stage={contact.lifecycle_stage} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Birthday">
                  {contact.birthday ? (
                    <span className="flex flex-wrap items-center gap-2">
                      {formatDay(contact.birthday)}
                      {untilBirthday !== null && (
                        <span className="text-xs text-slate-500">
                          {untilBirthday === 0
                            ? "today"
                            : `in ${untilBirthday} day${untilBirthday === 1 ? "" : "s"}`}
                        </span>
                      )}
                    </span>
                  ) : (
                    <Empty />
                  )}
                </Field>
              </FieldRow>
              <CustomFieldValues
                fields={customByCard("additional")}
                values={customValues}
                fieldOptions={options}
              />
              <FieldRow columns={1}>
                <Field label="Notes">
                  {notesHtml ? (
                    <div
                      className="space-y-2 leading-relaxed text-slate-700"
                      // Safe by construction: renderMarkdown escapes the stored
                      // text before applying formatting, so the only markup here
                      // is what it generated. Covered by tests/field-options.test.ts.
                      dangerouslySetInnerHTML={{ __html: notesHtml }}
                    />
                  ) : (
                    <Empty />
                  )}
                </Field>
              </FieldRow>
            </dl>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="Record history" className="order-8">
            <dl className="divide-y divide-slate-100">
              <FieldRow columns={1}>
                <Field label="Created by">
                  <span className="block">
                    {userName(contact.created_by) ?? "Unknown"}
                  </span>
                  <span className="text-xs text-slate-500">
                    <DateTime value={contact.created_at} />
                  </span>
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Updated by">
                  <span className="block">
                    {userName(contact.updated_by) ?? "Unknown"}
                  </span>
                  <span className="text-xs text-slate-500">
                    <DateTime value={contact.updated_at} />
                  </span>
                </Field>
              </FieldRow>
            </dl>
          </Section>

          {/*
            Consent is its own card rather than a line in Additional info: it is
            the answer to "may we email this person", which is a different kind
            of question from who owns the record.
          */}
          <Section title="Email consent" className="order-9">
            <dl className="divide-y divide-slate-100">
              <FieldRow columns={1}>
                <Field label="Basis">
                  {CONSENT_LABELS[contact.marketing_consent]}
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="How it was given">{contact.consent_source || <Empty />}</Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Recorded">
                  {contact.consent_at ? <DateTime value={contact.consent_at} /> : <Empty />}
                </Field>
              </FieldRow>
              {consentExpiry && (
                <FieldRow columns={1}>
                  <Field label="Implied consent runs out">
                    <DateTime value={consentExpiry.toISOString()} />
                  </Field>
                </FieldRow>
              )}
              <FieldRow columns={1}>
                <Field label="Can be emailed">
                  {emailBlock ? (
                    <span className="text-amber-700">No — {emailBlock.toLowerCase()}</span>
                  ) : (
                    <span className="text-emerald-700">Yes</span>
                  )}
                </Field>
              </FieldRow>
            </dl>

            {/*
              The override sits under the answer it changes rather than on the
              edit form, because it is a decision somebody makes while looking
              at that answer.
            */}
            {context.canWrite && (
              <form
                action={setMailableOverride}
                className="mt-4 space-y-2 border-t border-slate-100 pt-4"
              >
                <input type="hidden" name="id" value={id} />
                <label className="label" htmlFor="mailable_override">
                  Override
                </label>
                <select
                  id="mailable_override"
                  name="mailable_override"
                  className="input"
                  defaultValue={
                    contact.mailable_override === null
                      ? ""
                      : String(contact.mailable_override)
                  }
                >
                  {OVERRIDE_OPTIONS.map((option) => (
                    <option key={option.value || "rules"} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn-secondary w-full">
                  Save override
                </button>
                {manualOverride && (
                  <p className="text-xs text-slate-500">
                    {manualOverride}
                    {contact.mailable_override_at && (
                      <>
                        {" · "}
                        <DateTime value={contact.mailable_override_at} />
                      </>
                    )}
                  </p>
                )}
                <p className="text-xs text-slate-400">
                  An unsubscribe or a bounced address cannot be overridden.
                </p>
              </form>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
