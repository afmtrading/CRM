import Link from "next/link";
import { notFound } from "next/navigation";

import { requireSession, scoped, firstRow } from "@/lib/tenancy";
import { placeNames, type Place } from "@/lib/geography";
import { DateTime } from "@/components/date-time";
import { COMPANY_CARDS, optionsForField, safeUrl } from "@/lib/field-options";
import type {
  ActivityRow,
  CompanyRow,
  ContactCard,
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
import { PageHeader, Section } from "@/components/ui";
import { TagPicker } from "@/components/tag-picker";
import { CompanyRatingRows } from "@/components/company-rating";
import {
  CompanyAdditionalRows,
  CompanyContactsTable,
  CompanyDealsTable,
  CompanyDigitalRows,
  CompanyInfoRows,
} from "@/components/company-cards";
import {
  ExternalLink,
  Field,
  FieldRow,
  OptionBadges,
} from "@/components/contact-cards";

import { ActionForm, SubmitButton } from "@/components/action-form";

import { deleteCompany, setCompanyHidden, setCompanyTags } from "../actions";
import { addMarketplace } from "../../marketplaces/actions";

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
    { data: countryRows },
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
    /*
     * Reference data, not tenant data, which is why it is not scoped. based_in
     * and sells_in store codes; the card spells them out.
     */
    context.supabase
      .from("countries")
      .select("code, name, kind")
      .order("sort_order")
      .order("name"),
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

  const userName = (userId: string | null) => {
    if (!userId) return null;
    const user = userList.find((candidate) => candidate.id === userId);
    return user ? user.name || user.email : null;
  };

  const customFields = (customFieldDefs ?? []) as CustomFieldDefinitionRow[];
  const customByCard = (card: ContactCard) =>
    customFields.filter((field) => field.card === card);

  const places = placeNames((countryRows ?? []) as Place[]);

  const website = safeUrl(company.domain);

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
          ) : website ? (
            /* A web address under the name is worth clicking. It read as plain
               text before, which is the one thing a URL should never be. */
            <ExternalLink url={website} />
          ) : undefined
        }
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
          <Section
            title={COMPANY_CARDS[0].label}
            className="order-1"
            actions={
              <p className="min-w-0 truncate text-sm text-slate-500">
                Owner:{" "}
                <span className="font-semibold text-slate-900">
                  {userName(company.owner_id) ?? "—"}
                </span>
              </p>
            }
          >
            <dl className="divide-y divide-slate-100">
              <CompanyInfoRows
                company={company}
                options={options}
                customFields={customByCard("details")}
                contactCount={contactRows.length}
              />
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
            <CompanyContactsTable contacts={contactRows} options={options} />
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
            <CompanyDealsTable deals={dealRows} userName={userName} />
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
              <CompanyRatingRows
                company={company}
                options={options}
                customFields={customByCard("rating")}
                placeName={places.country}
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
              <CompanyDigitalRows
                company={company}
                options={options}
                customFields={customByCard("digital")}
              />
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
                autoSubmit
              />
            </form>
          </Section>

          <Section title={COMPANY_CARDS[1].label} className="order-7">
            <dl className="divide-y divide-slate-100">
              <CompanyAdditionalRows
                company={company}
                options={options}
                customFields={customByCard("additional")}
              />
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
