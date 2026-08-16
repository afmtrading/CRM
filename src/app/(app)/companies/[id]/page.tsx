import Link from "next/link";
import { notFound } from "next/navigation";

import { requireSession, scoped, firstRow } from "@/lib/tenancy";
import { contactName, formatDay } from "@/lib/format";
import { DateTime } from "@/components/date-time";
import { Money } from "@/components/money";
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
    { data: lineItems },
    { data: marketplace },
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
    // Line items reached through their deals: !inner turns the join into a
    // filter, so this returns only what this company's deals are for.
    scoped(context, "deal_products")
      .select("*, products(id, name), deals!inner(id, company_id, status, currency)")
      .eq("deals.company_id", id),
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
  })[];
  const contactRows = (contacts ?? []) as ContactRow[];

  /*
   * What this client buys, derived rather than stored: a company_products table
   * would be a second copy of something the won deals already say, and the two
   * would disagree the first time a deal was edited.
   */
  type CompanyLine = {
    line_total: number;
    quantity: number;
    products: { id: string; name: string } | null;
    deals: { status: string; currency: string } | null;
  };

  const purchases = new Map<
    string,
    { id: string; name: string; won: number; open: number; currency: string }
  >();

  for (const line of (lineItems ?? []) as CompanyLine[]) {
    if (!line.products || !line.deals) continue;
    const key = `${line.products.id}:${line.deals.currency}`;
    const entry = purchases.get(key) ?? {
      id: line.products.id,
      name: line.products.name,
      won: 0,
      open: 0,
      currency: line.deals.currency,
    };
    if (line.deals.status === "won") entry.won += Number(line.line_total);
    if (line.deals.status === "open") entry.open += Number(line.line_total);
    purchases.set(key, entry);
  }

  const purchaseRows = [...purchases.values()].sort((a, b) => b.won - a.won);

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
            <dl className="grid gap-3 sm:grid-cols-2">
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
              {/* Specialty market and company type moved to Company Rating —
                  what a business is, rather than how to reach it. */}
              <CustomFieldValues
                fields={customByCard("details")}
                values={customValues}
                fieldOptions={options}
              />

              {addresses.length > 0 && (
                <div className="sm:col-span-2">
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
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Merchandise" wide>
                <OptionBadges
                  values={company.specialty_market}
                  options={optionsFor("specialty_market")}
                />
              </Field>
              <Field label="Stock type" wide>
                <OptionBadges
                  values={company.stock_type}
                  options={optionsFor("stock_type")}
                />
              </Field>
              {/*
                Codes rather than names, deliberately. "CA · US · MX" reads at a
                glance on a card and is what the filters take; the full names
                would wrap to three lines and say no more.
              */}
              <Field label="Based in">
                {company.based_in_region ?? company.based_in ?? <Empty />}
              </Field>
              <Field label="Sells in">
                {company.sells_in.length > 0 ? company.sells_in.join(" · ") : <Empty />}
              </Field>
              <Field label="Sources from" wide>
                {company.sources_in.length > 0 ? company.sources_in.join(" · ") : <Empty />}
              </Field>
              <Field label="Company type" wide>
                <OptionBadges
                  values={company.customer_type}
                  options={optionsFor("customer_type")}
                />
              </Field>
              <CustomFieldValues
                fields={customByCard("rating")}
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
            <dl className="grid gap-3">
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

          <Section title="Tags" className="order-4">
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

          <Section title={COMPANY_CARDS[1].label} className="order-7">
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

          <Section title="Products" className="order-9">
            {purchaseRows.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nothing yet. This is built from the line items on this
                client&rsquo;s deals.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {purchaseRows.map((row) => (
                  <li
                    key={`${row.id}-${row.currency}`}
                    className="flex items-start justify-between gap-3"
                  >
                    <Link
                      href={`/products/${row.id}`}
                      className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 hover:text-brand-700"
                    >
                      {row.name}
                    </Link>
                    {/* Already grouped by currency — the key is id + currency —
                        so each line is one currency and needs saying which. */}
                    <div className="shrink-0 text-right">
                      <Money
                        value={row.won}
                        currency={row.currency}
                        amountClassName="text-sm font-semibold text-slate-900"
                      />
                      {row.open > 0 && (
                        <p className="text-xs text-slate-500">
                          <Money value={row.open} currency={row.currency} /> open
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Record history" className="order-8">
            <dl className="space-y-3">
              <Field label="Created by">
                <span className="block">
                  {userName(company.created_by) ?? "Unknown"}
                </span>
                <span className="text-xs text-slate-500">
                  <DateTime value={company.created_at} />
                </span>
              </Field>
              <Field label="Updated by">
                <span className="block">
                  {userName(company.updated_by) ?? "Unknown"}
                </span>
                <span className="text-xs text-slate-500">
                  <DateTime value={company.updated_at} />
                </span>
              </Field>
            </dl>
          </Section>
        </div>
      </div>
    </>
  );
}
