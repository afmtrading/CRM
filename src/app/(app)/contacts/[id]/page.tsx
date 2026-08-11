import Link from "next/link";
import { notFound } from "next/navigation";

import { requireSession, scoped, firstRow } from "@/lib/tenancy";
import { contactName, formatDay } from "@/lib/format";
import { DateTime } from "@/components/date-time";
import { Money } from "@/components/money";
import {
  CONTACT_CARDS,
  daysUntilBirthday,
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
  Avatar,
  DealStatusBadge,
  LifecycleBadge,
  PageHeader,
  ScoreMeter,
  Section,
} from "@/components/ui";
import { CalendarIcon } from "@/components/icons";
import {
  CardLink,
  ContactMethod,
  CustomFieldValues,
  Empty,
  ExternalLink,
  Field,
  OptionBadge,
  OptionBadges,
  optionColor,
} from "@/components/contact-cards";

import { deleteContact, mergeContactsAction, setContactTags } from "../actions";

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

  const contact = await firstRow<
    ContactRow & {
      companies: { id: string; name: string; domain: string | null } | null;
    }
  >(
    scoped(context, "contacts")
      .select("*, companies(id, name, domain)")
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
    { data: productInterest },
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
    scoped(context, "custom_field_definitions")
      .select("*")
      .eq("entity_type", "contact")
      .order("order"),
    scoped(context, "contact_products")
      .select("product_id, products(id, name)")
      .eq("contact_id", id),
    context.supabase.rpc("find_duplicate_contacts", {
      p_email: contact.email,
      p_first_name: contact.first_name,
      p_last_name: contact.last_name,
      p_phone: contact.phone,
      p_exclude_id: contact.id,
    }),
  ]);

  const interests = (
    (productInterest ?? []) as { products: { id: string; name: string } | null }[]
  )
    .map((row) => row.products)
    .filter((product): product is { id: string; name: string } => product !== null);

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
  const optionsFor = (key: string) =>
    options.filter((option) => option.field_key === key);

  const userName = (userId: string | null) => {
    if (!userId) return null;
    const user = userList.find((candidate) => candidate.id === userId);
    return user ? user.name || user.email : null;
  };

  // Custom fields are grouped by the card their admin assigned them to.
  const customFields = (customFieldDefs ?? []) as CustomFieldDefinitionRow[];
  const customByCard = (card: ContactCard) =>
    customFields.filter((field) => field.card === card);
  const customValues = (contact.custom_fields ?? {}) as Record<string, unknown>;

  const name = contactName(contact);
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
        description={contact.job_title ?? undefined}
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
          </>
        }
      />

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
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-3 lg:items-start">
        {/* Contact details leads — it is what someone opened the page for. */}
        <div className="order-1 lg:col-span-2 lg:col-start-1 lg:row-start-1">
          <Section title={CONTACT_CARDS[0].label}>
            <div className="mb-4 flex items-center gap-3">
              <Avatar name={name} className="h-11 w-11 text-sm" />
              <div className="min-w-0">
                <p className="truncate font-semibold text-slate-900">{name}</p>
                <p className="truncate text-xs text-slate-500">
                  {contact.job_title ?? "No job title"}
                </p>
              </div>
            </div>

            {/*
              Two columns rather than four, for the narrower card. The email
              keeps a row of its own because addresses are the long value here;
              the two phone numbers are short enough to sit side by side.
            */}
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Company">
                {contact.companies ? (
                  <CardLink href={`/companies/${contact.companies.id}`}>
                    {contact.companies.name}
                  </CardLink>
                ) : (
                  <Empty />
                )}
              </Field>
              <Field label="Job title">{contact.job_title || <Empty />}</Field>
              <Field label="Primary email" wide>
                <ContactMethod
                  value={contact.email}
                  kind="email"
                  label={name}
                />
              </Field>
              <Field label="Mobile phone">
                <ContactMethod value={contact.phone} kind="phone" label={name} />
              </Field>
              <Field label="Office phone">
                <ContactMethod
                  value={contact.office_phone}
                  kind="phone"
                  label={name}
                />
              </Field>
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
        */}
        <div className="order-3 space-y-5 lg:col-span-2 lg:col-start-1 lg:row-start-2">
          <Section
            title="Deals"
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

          <Section title="Activity">
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
        <div className="order-2 space-y-5 lg:col-start-3 lg:row-span-2 lg:row-start-1">
          <Section title={CONTACT_CARDS[1].label}>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Role type" wide>
                <OptionBadges
                  values={contact.role_type}
                  options={optionsFor("role_type")}
                />
              </Field>
              <Field label="Priority">
                {contact.priority ? (
                  <OptionBadge
                    value={contact.priority}
                    color={optionColor(
                      optionsFor("priority"),
                      contact.priority,
                    )}
                  />
                ) : (
                  <Empty />
                )}
              </Field>
              <Field label="Credibility">
                {contact.credibility ? (
                  <OptionBadge
                    value={contact.credibility}
                    color={optionColor(
                      optionsFor("credibility"),
                      contact.credibility,
                    )}
                  />
                ) : (
                  <Empty />
                )}
              </Field>
              <Field label="Interested in" wide>
                {interests.length === 0 ? (
                  <Empty />
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {interests.map((product) => (
                      <Link
                        key={product.id}
                        href={`/products/${product.id}`}
                        className="badge bg-brand-100 text-brand-700 hover:bg-brand-200"
                      >
                        {product.name}
                      </Link>
                    ))}
                  </div>
                )}
              </Field>
              <CustomFieldValues
                fields={customByCard("influence")}
                values={customValues}
                fieldOptions={options}
              />
            </dl>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title={CONTACT_CARDS[2].label}>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Owner">
                {userName(contact.owner_id) ?? <Empty />}
              </Field>
              <Field label="Lead score">
                <ScoreMeter score={contact.lead_score} />
              </Field>
              <Field label="Source">{contact.source || <Empty />}</Field>
              <Field label="Lifecycle stage">
                <LifecycleBadge stage={contact.lifecycle_stage} />
              </Field>
              <Field label="Birthday" wide>
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
              <CustomFieldValues
                fields={customByCard("additional")}
                values={customValues}
                fieldOptions={options}
              />
              <Field label="Notes" wide>
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
            </dl>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title={CONTACT_CARDS[3].label}>
            <dl className="grid gap-3">
              <Field label="Company website">
                <ExternalLink url={companyWebsite} />
              </Field>
              <Field label="LinkedIn">
                <ExternalLink url={socialUrl("linkedin", contact.linkedin)} />
              </Field>
              <Field label="Facebook">
                <ExternalLink url={socialUrl("facebook", contact.facebook)} />
              </Field>
              <Field label="Instagram">
                <ExternalLink url={socialUrl("instagram", contact.instagram)} />
              </Field>
              <Field label="TikTok">
                <ExternalLink url={socialUrl("tiktok", contact.tiktok)} />
              </Field>
              <Field label="X (Twitter)">
                <ExternalLink url={socialUrl("x_twitter", contact.x_twitter)} />
              </Field>
              <CustomFieldValues
                fields={customByCard("digital")}
                values={customValues}
                fieldOptions={options}
              />

              {extraLinks.length > 0 && (
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
              )}
            </dl>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="Record history">
            <dl className="space-y-3">
              <Field label="Created by">
                <span className="block">
                  {userName(contact.created_by) ?? "Unknown"}
                </span>
                <span className="text-xs text-slate-500">
                  <DateTime value={contact.created_at} />
                </span>
              </Field>
              <Field label="Updated by">
                <span className="block">
                  {userName(contact.updated_by) ?? "Unknown"}
                </span>
                <span className="text-xs text-slate-500">
                  <DateTime value={contact.updated_at} />
                </span>
              </Field>
            </dl>
          </Section>

          <Section title="Tags">
            {tagList.length === 0 ? (
              <p className="text-sm text-slate-500">
                No tags defined yet.{" "}
                {context.isAdmin && (
                  <Link
                    href="/settings/tags"
                    className="text-brand-700 hover:underline"
                  >
                    Create some
                  </Link>
                )}
              </p>
            ) : (
              <form action={setContactTags} className="space-y-3">
                <input type="hidden" name="contact_id" value={id} />
                <div className="flex flex-wrap gap-2">
                  {tagList.map((tag) => (
                    <label
                      key={tag.id}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        name="tag_ids"
                        value={tag.id}
                        defaultChecked={selectedTagIds.has(tag.id)}
                        className="rounded border-slate-300"
                      />
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: tag.color }}
                        aria-hidden
                      />
                      {tag.name}
                    </label>
                  ))}
                </div>
                <button type="submit" className="btn-secondary">
                  Save tags
                </button>
              </form>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
