import Link from "next/link";
import { notFound } from "next/navigation";

import { requireSession, scoped, firstRow } from "@/lib/tenancy";
import {
  contactName,
  formatCurrency,
  formatDate,
  formatDateTime,
} from "@/lib/format";
import {
  COMPANY_CARDS,
  renderMarkdown,
  safeUrl,
  socialUrl,
} from "@/lib/field-options";
import type {
  ActivityRow,
  CompanyAddress,
  CompanyRow,
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
  Section,
} from "@/components/ui";
import { MailIcon, PhoneIcon } from "@/components/icons";
import {
  CardLink,
  ContactMethod,
  CustomFieldValues,
  Empty,
  ExternalLink,
  Field,
  OptionBadges,
} from "@/components/contact-cards";

import { deleteCompany, setCompanyTags } from "../actions";

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requireSession();

  const company = await firstRow<CompanyRow>(
    scoped(context, "companies").select("*").eq("id", id).maybeSingle(),
  );

  if (!company) notFound();

  const [
    { data: contacts },
    { data: deals },
    { data: activities },
    { data: users },
    { data: tags },
    { data: companyTags },
    { data: fieldOptions },
    { data: customFieldDefs },
  ] = await Promise.all([
    scoped(context, "contacts")
      .select("*")
      .eq("company_id", id)
      .is("duplicate_of_id", null)
      .is("deleted_at", null)
      .order("last_name"),
    scoped(context, "deals")
      .select("*, stages(name)")
      .eq("company_id", id)
      .order("created_at", { ascending: false }),
    scoped(context, "activities")
      .select("*")
      .eq("related_to_type", "company")
      .eq("related_to_id", id)
      .order("occurred_at", { ascending: false })
      .limit(100),
    scoped(context, "users").select("*").order("name"),
    scoped(context, "tags").select("*").order("name"),
    scoped(context, "company_tags").select("tag_id").eq("company_id", id),
    scoped(context, "field_options").select("*").order("order"),
    scoped(context, "custom_field_definitions")
      .select("*")
      .eq("entity_type", "company")
      .order("order"),
  ]);

  const userList = (users ?? []) as UserRow[];
  const tagList = (tags ?? []) as TagRow[];
  const selectedTagIds = new Set(
    ((companyTags ?? []) as { tag_id: string }[]).map((t) => t.tag_id),
  );
  const dealRows = (deals ?? []) as (DealRow & {
    stages: { name: string } | null;
  })[];
  const contactRows = (contacts ?? []) as ContactRow[];

  const options = (fieldOptions ?? []) as FieldOptionRow[];
  const optionsFor = (key: string) =>
    options.filter((option) => option.field_key === key);

  const userName = (userId: string | null) => {
    if (!userId) return null;
    const user = userList.find((candidate) => candidate.id === userId);
    return user ? user.name || user.email : null;
  };

  const customFields = (customFieldDefs ?? []) as CustomFieldDefinitionRow[];
  const customByCard = (card: ContactCard) =>
    customFields.filter((field) => field.card === card);
  const customValues = (company.custom_fields ?? {}) as Record<string, unknown>;

  const website = safeUrl(company.domain);
  const notesHtml = renderMarkdown(company.notes);
  const extraLinks = Array.isArray(company.links)
    ? (company.links as ContactLink[])
    : [];
  const addresses = Array.isArray(company.addresses)
    ? (company.addresses as CompanyAddress[])
    : [];

  return (
    <>
      <PageHeader
        title={company.name}
        description={company.domain ?? undefined}
        actions={
          <>
            {context.canWrite && (
              <Link
                href={`/contacts/new?company_id=${id}`}
                className="btn-secondary"
              >
                New contact
              </Link>
            )}
            {context.canWrite && (
              <Link href={`/companies/${id}/edit`} className="btn-secondary">
                Edit
              </Link>
            )}
            {context.canWrite && (
              <form action={deleteCompany}>
                <input type="hidden" name="id" value={id} />
                <button type="submit" className="btn-danger">
                  Delete
                </button>
              </form>
            )}
          </>
        }
      />

      {/* Company info leads, above the activity feed, for the same reason it
          does on a contact: the record is what someone opened the page for. */}
      <div className="mb-5">
        <Section title={COMPANY_CARDS[0].label}>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Company name">{company.name}</Field>
            <Field label="Website">
              <ExternalLink url={website} />
            </Field>
            <Field label="Owner">
              {userName(company.owner_id) ?? <Empty />}
            </Field>
            <Field label="Company phone">
              <ContactMethod
                value={company.phone}
                kind="phone"
                label={company.name}
              />
            </Field>
            <Field label="Company email">
              <ContactMethod
                value={company.email}
                kind="email"
                label={company.name}
              />
            </Field>
            <Field label="Contacts">{contactRows.length}</Field>
            <Field label="Specialty market" wide>
              <OptionBadges
                values={company.specialty_market}
                options={optionsFor("specialty_market")}
              />
            </Field>
            <Field label="Company type" wide>
              <OptionBadges
                values={company.customer_type}
                options={optionsFor("customer_type")}
              />
            </Field>
            <CustomFieldValues
              fields={customByCard("details")}
              values={customValues}
              fieldOptions={options}
            />

            {addresses.length > 0 && (
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-xs font-medium text-slate-500">
                  Addresses
                </dt>
                <dd className="mt-1 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {addresses.map((entry, index) => (
                    <div
                      key={`${entry.label}-${index}`}
                      className="rounded-xl bg-slate-50 p-3"
                    >
                      <p className="text-xs font-medium text-slate-500">
                        {entry.label || `Address ${index + 1}`}
                      </p>
                      <p className="mt-0.5 text-sm whitespace-pre-line text-slate-800">
                        {entry.address}
                      </p>
                    </div>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        </Section>
      </div>

      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-3">
        <div className="order-2 space-y-5 lg:order-1 lg:col-span-2">
          <Section
            title="Contacts"
            actions={
              <Link
                href={`/contacts/new?company_id=${id}`}
                className="btn-secondary py-1"
              >
                New contact
              </Link>
            }
          >
            {contactRows.length === 0 ? (
              <p className="text-sm text-slate-500">
                No contacts at this company yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Job title</th>
                      <th>Stage</th>
                      <th>Score</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contactRows.map((contact) => {
                      const name = contactName(contact);
                      return (
                        <tr
                          key={contact.id}
                          className="transition-colors hover:bg-slate-50/70"
                        >
                          <td>
                            <div className="flex items-center gap-3">
                              <Avatar name={name} className="h-8 w-8" />
                              <Link
                                href={`/contacts/${contact.id}`}
                                className="truncate font-medium text-slate-900 hover:text-brand-700"
                              >
                                {name}
                              </Link>
                            </div>
                          </td>
                          <td className="text-slate-600">
                            {contact.job_title ?? "—"}
                          </td>
                          <td>
                            <LifecycleBadge stage={contact.lifecycle_stage} />
                          </td>
                          <td className="font-medium text-slate-700">
                            {contact.lead_score}
                          </td>
                          {/* The email column is gone: the icon does the job it
                              was doing, and the row gets the space back. */}
                          <td>
                            <div className="flex items-center justify-end gap-1">
                              {contact.phone && (
                                <a
                                  href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}
                                  aria-label={`Call ${name}`}
                                  title={contact.phone}
                                  className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                                >
                                  <PhoneIcon className="h-4 w-4" />
                                </a>
                              )}
                              {contact.email && (
                                <a
                                  href={`mailto:${contact.email}`}
                                  aria-label={`Email ${name}`}
                                  title={contact.email}
                                  className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                                >
                                  <MailIcon className="h-4 w-4" />
                                </a>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Activity">
            <ActivityComposer
              relatedToType="company"
              relatedToId={id}
              users={userList}
              currentUserId={context.user.id}
            />
            <div className="mt-4 border-t border-slate-100 pt-2">
              <ActivityTimeline
                activities={(activities ?? []) as ActivityRow[]}
                users={userList}
                returnTo={`/companies/${id}`}
                emptyMessage="Nothing logged against this company yet."
              />
            </div>
          </Section>

          <Section
            title="Deals"
            actions={
              <Link
                href={`/deals/new?company_id=${id}`}
                className="btn-secondary py-1"
              >
                New deal
              </Link>
            }
          >
            {dealRows.length === 0 ? (
              <p className="text-sm text-slate-500">
                No deals linked to this company.
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
                        <td>{formatCurrency(deal.value, deal.currency)}</td>
                        <td>
                          <DealStatusBadge status={deal.status} />
                        </td>
                        <td>{formatDate(deal.expected_close_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>

        <div className="order-1 space-y-5 lg:order-2">
          <Section title={COMPANY_CARDS[2].label}>
            <dl className="grid gap-3">
              <Field label="Company website">
                <ExternalLink url={website} />
              </Field>
              <Field label="LinkedIn">
                <ExternalLink url={socialUrl("linkedin", company.linkedin)} />
              </Field>
              <Field label="Facebook">
                <ExternalLink url={socialUrl("facebook", company.facebook)} />
              </Field>
              <Field label="Instagram">
                <ExternalLink url={socialUrl("instagram", company.instagram)} />
              </Field>
              <Field label="TikTok">
                <ExternalLink url={socialUrl("tiktok", company.tiktok)} />
              </Field>
              <Field label="X (Twitter)">
                <ExternalLink url={socialUrl("x_twitter", company.x_twitter)} />
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

          <Section title={COMPANY_CARDS[1].label}>
            <dl className="space-y-3">
              <Field label="Owner">
                {userName(company.owner_id) ?? <Empty />}
              </Field>
              <CustomFieldValues
                fields={customByCard("additional")}
                values={customValues}
                fieldOptions={options}
              />
              <Field label="Notes">
                {notesHtml ? (
                  <div
                    className="space-y-2 leading-relaxed text-slate-700"
                    // Safe by construction: renderMarkdown escapes the stored
                    // text before applying formatting.
                    dangerouslySetInnerHTML={{ __html: notesHtml }}
                  />
                ) : (
                  <Empty />
                )}
              </Field>
            </dl>
          </Section>

          <Section title="Tags">
            {tagList.length === 0 ? (
              <p className="text-sm text-slate-500">
                No tags defined yet.{" "}
                {context.isAdmin && (
                  <CardLink href="/settings/tags">Create some</CardLink>
                )}
              </p>
            ) : (
              <form action={setCompanyTags} className="space-y-3">
                <input type="hidden" name="company_id" value={id} />
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

          <Section title="Record history">
            <dl className="space-y-3">
              <Field label="Created by">
                <span className="block">
                  {userName(company.created_by) ?? "Unknown"}
                </span>
                <span className="text-xs text-slate-500">
                  {formatDateTime(company.created_at)}
                </span>
              </Field>
              <Field label="Updated by">
                <span className="block">
                  {userName(company.updated_by) ?? "Unknown"}
                </span>
                <span className="text-xs text-slate-500">
                  {formatDateTime(company.updated_at)}
                </span>
              </Field>
            </dl>
          </Section>
        </div>
      </div>
    </>
  );
}
