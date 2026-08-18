import Link from "next/link";
import { notFound } from "next/navigation";

import { requireSession, scoped, firstRow } from "@/lib/tenancy";
import { contactName, formatDay } from "@/lib/format";
import { companyFieldValues, findCompanyField } from "@/lib/company-fields";
import { DateTime } from "@/components/date-time";
import { Money } from "@/components/money";
import {
  COMPANY_CARDS,
  optionsForField,
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
  DealStatusBadge,
  PageHeader,
  Section,
} from "@/components/ui";
import { MailIcon, PhoneIcon } from "@/components/icons";
import { TagPicker } from "@/components/tag-picker";
import {
  ContactMethod,
  CustomFieldValues,
  Empty,
  ExternalLink,
  Field,
  FieldRow,
  OptionBadges,
} from "@/components/contact-cards";

import { ActionForm, SubmitButton } from "@/components/action-form";

import { deleteCompany, setCompanyHidden, setCompanyTags } from "../actions";
import { addMarketplace } from "../../marketplaces/actions";

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
    { data: marketplace },
  ] = await Promise.all([
    scoped(context, "contacts")
      .select("*")
      .eq("company_id", id)
      .is("duplicate_of_id", null)
      .is("deleted_at", null)
      .order("last_name"),
    scoped(context, "deals")
      .select("*, stages(name), contacts(id, first_name, last_name)")
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
    // Whether this company is also a channel. A profile row is the whole
    // answer; its absence is the other half of it.
    scoped(context, "marketplace_profiles")
      .select("company_id, sells_through, sources_from")
      .eq("company_id", id)
      .maybeSingle(),
  ]);

  const userList = (users ?? []) as UserRow[];
  const tagList = (tags ?? []) as TagRow[];
  const selectedTagIds = new Set(
    ((companyTags ?? []) as { tag_id: string }[]).map((t) => t.tag_id),
  );
  const dealRows = (deals ?? []) as (DealRow & {
    stages: { name: string } | null;
    contacts: { id: string; first_name: string; last_name: string } | null;
  })[];
  const contactRows = (contacts ?? []) as ContactRow[];


  const options = (fieldOptions ?? []) as FieldOptionRow[];
  /*
   * Scoped to the record the field belongs to, not just the key. `priority` is
   * a list on companies, another on contacts and another on products, and
   * matching the key alone draws all three — which is how a badge ends up
   * wearing another record type's colour.
   */
  const optionsFor = (key: string) => optionsForField(options, "company", key);
  const contactOptionsFor = (key: string) => optionsForField(options, "contact", key);

  const userName = (userId: string | null) => {
    if (!userId) return null;
    const user = userList.find((candidate) => candidate.id === userId);
    return user ? user.name || user.email : null;
  };

  const customFields = (customFieldDefs ?? []) as CustomFieldDefinitionRow[];
  const customByCard = (card: ContactCard) =>
    customFields.filter((field) => field.card === card);
  const customValues = (company.custom_fields ?? {}) as Record<string, unknown>;

  /*
   * Size is promoted next to the country, so it is taken out of the list the
   * card renders generically — otherwise it appears twice, once where it was
   * asked for and once at the bottom with the rest.
   */
  const sizeField = findCompanyField(customFields, "size");
  const sizeValues = sizeField ? companyFieldValues(company.custom_fields, sizeField) : [];
  const ratingCustomFields = customByCard("rating").filter(
    (field) => field.id !== sizeField?.id,
  );

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
        /*
          What kind of business this is, rather than its web address. The
          address is already the second row of Company info, and a line under
          the name is worth more to somebody scanning the record than a
          repeated URL — "Liquidation Retailer" tells you how to think about
          the company before you have read anything else.
        */
        description={
          company.customer_type.length > 0 ? (
            <OptionBadges
              values={company.customer_type}
              options={optionsFor("customer_type")}
            />
          ) : (
            (company.domain ?? undefined)
          )
        }
        actions={
          <>
            {/*
              Beside the name, like a deal's. Who owns an account is what
              somebody checks before acting on it, and the name is louder than
              its label because the name is the answer.
            */}
            <div className="mr-2 min-w-0 text-right">
              <p className="text-xs text-slate-500">Owner</p>
              <p className="truncate text-base font-semibold text-slate-900">
                {userName(company.owner_id) ?? "—"}
              </p>
            </div>
            {context.canWrite && (
              <Link
                href={`/contacts/new?company_id=${id}`}
                className="btn-secondary"
              >
                New contact
              </Link>
            )}
            {/*
              A company can be a channel as well as a counterparty — an
              auctioneer who also buys is one record, not two — so this is a
              link rather than a switch away from being a company.
            */}
            {marketplace ? (
              <Link href={`/marketplaces/${id}`} className="btn-secondary">
                Marketplace
              </Link>
            ) : (
              context.canWrite && (
                <ActionForm action={addMarketplace}>
                  <input type="hidden" name="company_id" value={id} />
                  <input type="hidden" name="sells_through" value="on" />
                  <SubmitButton className="btn-secondary" pendingLabel="Adding…">
                    Add as marketplace
                  </SubmitButton>
                </ActionForm>
              )
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
            {context.canSeeHidden && (
              <ActionForm action={setCompanyHidden}>
                <input type="hidden" name="id" value={id} />
                <input
                  type="hidden"
                  name="hidden"
                  value={company.hidden ? "false" : "true"}
                />
                <SubmitButton className="btn-secondary" pendingLabel="Working…">
                  {company.hidden ? "Unhide" : "Hide"}
                </SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />

      {company.hidden && (
        <p className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
          <strong className="font-semibold">Hidden.</strong> Nobody without
          &ldquo;See hidden records&rdquo; can find this company. Its contacts
          are not hidden with it &mdash; hide those separately if they should
          be.
        </p>
      )}

      {/*
        Three regions rather than two columns: the record, the sidebar beside
        it, and everything the record accumulates underneath. The sidebar is
        given its own row placement so it can start level with the top of the
        record instead of below it — the whole page used to begin with one
        full-width card and a band of empty space to its right.
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
        {/* Company info leads, above the activity feed, for the same reason it
            does on a contact: the record is what someone opened the page for. */}
        <div className="contents lg:block lg:col-span-2 lg:col-start-1 lg:row-start-1">
          <Section title={COMPANY_CARDS[0].label} className="order-1">
            <dl className="divide-y divide-slate-100">
              <FieldRow>
                <Field label="Company name">{company.name}</Field>
                <Field label="Website">
                  <ExternalLink url={website} />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field label="Owner">
                  {userName(company.owner_id) ?? <Empty />}
                </Field>
                <Field label="Contacts">{contactRows.length}</Field>
              </FieldRow>
              <FieldRow>
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
              </FieldRow>
              {/* Specialty market and company type moved to Company Rating —
                  what a business is, rather than how to reach it. */}
              <CustomFieldValues
                fields={customByCard("details")}
                values={customValues}
                fieldOptions={options}
              />

              {addresses.length > 0 && (
                <FieldRow columns={1}>
                  <div>
                    <dt className="text-xs font-medium text-slate-500">
                      Addresses
                    </dt>
                    <dd className="mt-1 grid gap-3 sm:grid-cols-2">
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
                </FieldRow>
              )}
            </dl>
          </Section>
        </div>

        {/*
          Deals sit directly under the record, ahead of the contact list and the
          activity feed: what is being sold to this business is the reason to
          open its page, and it was previously below both.
        */}
        <div className="contents lg:block lg:space-y-5 lg:col-span-2 lg:col-start-1 lg:row-start-2">
          <Section
            title="Contacts"
            className="order-6"
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
                      {/*
                        Priority, role and credibility rather than stage and
                        lead score. On a company's own page the question is who
                        to call and how much weight to give them, which is what
                        these three answer; the stage is about a pipeline this
                        table is not showing.
                      */}
                      <th>Priority</th>
                      <th>Role type</th>
                      <th>Credibility</th>
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
                            {contact.priority ? (
                              <OptionBadges
                                values={[contact.priority]}
                                options={contactOptionsFor("priority")}
                              />
                            ) : (
                              <Empty />
                            )}
                          </td>
                          <td>
                            <OptionBadges
                              values={contact.role_type}
                              options={contactOptionsFor("role_type")}
                            />
                          </td>
                          <td>
                            {contact.credibility ? (
                              <OptionBadges
                                values={[contact.credibility]}
                                options={contactOptionsFor("credibility")}
                              />
                            ) : (
                              <Empty />
                            )}
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

          <Section
            title="Deals"
            className="order-5"
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
                      {/*
                        Who it is with and who is running it. On a company with
                        several open deals those are the two things that tell
                        them apart, and both meant opening each deal to find out.
                      */}
                      <th>Contact</th>
                      <th>Owner</th>
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
                        <td>
                          {deal.contacts ? (
                            <Link
                              href={`/contacts/${deal.contacts.id}`}
                              className="text-slate-600 hover:text-brand-700"
                            >
                              {contactName(deal.contacts)}
                            </Link>
                          ) : (
                            <Empty />
                          )}
                        </td>
                        <td className="text-slate-600">
                          {userName(deal.owner_id) ?? <Empty />}
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
        </div>

        {/*
          The sidebar starts level with the record on a wide screen, and comes
          straight after it on a narrow one — before the activity feed, which is
          long and is not what most visits are for.
        */}
        <div className="contents lg:block lg:space-y-5 lg:col-start-3 lg:row-span-2 lg:row-start-1">
          {/*
            Company Rating leads the sidebar, in the place Influence holds on a
            contact and for the same reason: what kind of business this is, is
            the first thing worth knowing after which business it is.
          */}
          <Section title={COMPANY_CARDS[3].label} className="order-2">
            <dl className="divide-y divide-slate-100">
              {/* First on the card, because how much an account matters is the
                  thing somebody scans a record for before anything else. */}
              <FieldRow columns={1}>
                <Field label="Priority">
                  {company.priority ? (
                    <OptionBadges
                      values={[company.priority]}
                      options={optionsFor("priority")}
                    />
                  ) : (
                    <Empty />
                  )}
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Merchandise">
                  <OptionBadges
                    values={company.specialty_market}
                    options={optionsFor("specialty_market")}
                  />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Stock type">
                  <OptionBadges
                    values={company.stock_type}
                    options={optionsFor("stock_type")}
                  />
                </Field>
              </FieldRow>
              {/*
                Codes rather than names, deliberately. "CA · US · MX" reads at a
                glance on a card and is what the filters take; the full names
                would wrap to three lines and say no more.
              */}
              {/*
                Size sits beside the country rather than down among the custom
                fields, because "a big US buyer" is one thought and reading it
                meant jumping the length of the card. It is still whatever field
                this organization defined — matched by name, not assumed.
              */}
              <FieldRow>
                <Field label="Base Country">
                  {company.based_in ?? <Empty />}
                </Field>
                {sizeField ? (
                  <Field label={sizeField.label}>
                    {sizeValues.length > 0 ? (
                      <OptionBadges
                        values={sizeValues}
                        options={options.filter(
                          (option) =>
                            option.entity_type === "company" &&
                            option.field_key === sizeField.key,
                        )}
                      />
                    ) : (
                      <Empty />
                    )}
                  </Field>
                ) : (
                  <span />
                )}
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Sells To">
                  {company.sells_in.length > 0 ? company.sells_in.join(" · ") : <Empty />}
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Company type">
                  <OptionBadges
                    values={company.customer_type}
                    options={optionsFor("customer_type")}
                  />
                </Field>
              </FieldRow>
              <CustomFieldValues
                fields={ratingCustomFields}
                values={customValues}
                fieldOptions={options}
              />
            </dl>
          </Section>

          <Section title={COMPANY_CARDS[2].label} className="order-3">
            {/*
              No website field here: it is the first thing in Company info, and
              a value repeated in two cards is a value that can look like it
              disagrees with itself. This card is the social profiles.
            */}
            <dl className="divide-y divide-slate-100">
              <FieldRow columns={1}>
                <Field label="LinkedIn">
                  <ExternalLink url={socialUrl("linkedin", company.linkedin)} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Facebook">
                  <ExternalLink url={socialUrl("facebook", company.facebook)} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Instagram">
                  <ExternalLink url={socialUrl("instagram", company.instagram)} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="TikTok">
                  <ExternalLink url={socialUrl("tiktok", company.tiktok)} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="X (Twitter)">
                  <ExternalLink url={socialUrl("x_twitter", company.x_twitter)} />
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="YouTube">
                  <ExternalLink url={socialUrl("youtube", company.youtube)} />
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

          <Section title="Tags" className="order-4">
            {/* The same control the company form carries — see the contact page. */}
            <form action={setCompanyTags} className="space-y-3">
              <input type="hidden" name="company_id" value={id} />
              <TagPicker
                tags={tagList}
                selected={selectedTagIds}
                canManage={context.isAdmin}
                canCreate={context.canWrite}
              />
              {context.canWrite && (
                <button type="submit" className="btn-secondary">
                  Save tags
                </button>
              )}
            </form>
          </Section>

          <Section title={COMPANY_CARDS[1].label} className="order-7">
            <dl className="divide-y divide-slate-100">
              <FieldRow columns={1}>
                <Field label="Owner">
                  {userName(company.owner_id) ?? <Empty />}
                </Field>
              </FieldRow>
              <CustomFieldValues
                fields={customByCard("additional")}
                values={customValues}
                fieldOptions={options}
                columns={1}
              />
              <FieldRow columns={1}>
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
              </FieldRow>
            </dl>
          </Section>


          <Section title="Record history" className="order-8">
            <dl className="divide-y divide-slate-100">
              <FieldRow columns={1}>
                <Field label="Created by">
                  <span className="block">
                    {userName(company.created_by) ?? "Unknown"}
                  </span>
                  <span className="text-xs text-slate-500">
                    <DateTime value={company.created_at} />
                  </span>
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Updated by">
                  <span className="block">
                    {userName(company.updated_by) ?? "Unknown"}
                  </span>
                  <span className="text-xs text-slate-500">
                    <DateTime value={company.updated_at} />
                  </span>
                </Field>
              </FieldRow>
            </dl>
          </Section>
        </div>
      </div>
    </>
  );
}
