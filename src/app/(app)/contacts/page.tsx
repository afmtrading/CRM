import Link from "next/link";

import { requireSession, scoped } from "@/lib/tenancy";
import {
  applyFilter,
  fieldsFor,
  filterFromSearchParams,
  groupRowsNested,
  labelFromFields,
  parseFilterConfig,
} from "@/lib/filters";
import { contactName, formatDay } from "@/lib/format";
import type {
  FieldOptionRow,
  ContactRow,
  CompanyRow,
  CustomFieldDefinitionRow,
  SavedFilterRow,
  TagRow,
  UserRow,
} from "@/lib/database.types";
import {
  companyFieldValues,
  findCompanyField,
} from "@/lib/company-fields";
import {
  BulkEdit,
  SelectAll,
  SelectRow,
} from "@/components/bulk-bar";
import { bulkFieldsFor } from "@/lib/bulk-edit";
import { columnCatalogue, resolveColumns } from "@/lib/table-columns";
import { ColumnPicker } from "@/components/column-picker";
import { readColumns } from "../column-actions";
import { ConsentBar } from "@/components/consent-bar";
import { FilterBar } from "@/components/filter-bar";
import {
  CustomCell,
  Empty,
  OptionBadge,
  OptionBadges,
  optionColor,
} from "@/components/contact-cards";
import {
  EmptyState,
  ErrorNote,
  LifecycleBadge,
  PageHeader,
  StatCard,
  StatGrid,
  SubGroupRow,
} from "@/components/ui";
import {
  AlertIcon,
  AwardIcon,
  ContactsIcon,
  ImportIcon,
  MailIcon,
  PhoneIcon,
  PlusIcon,
  TrendingUpIcon,
} from "@/components/icons";

import { deleteSavedFilter, saveFilter } from "./actions";

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

export const metadata = { title: "Contacts · FLO CRM" };

const PAGE_SIZE = 200;

/** Filter conditions travel in the URL as a JSON `f` param (see filterToSearchParams). */
const UNASSIGNED_VIEW = `/contacts?f=${encodeURIComponent(
  JSON.stringify([{ field: "owner_id", operator: "is_empty", value: "" }]),
)}`;

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const context = await requireSession();

  const [
    { data: savedFilters },
    { data: customFields },
    { data: owners },
    { data: companies },
    { data: fieldOptionRows },
    { data: tagRows },
    { data: contactTagRows },
    { data: emailLists },
  ] = await Promise.all([
    scoped(context, "saved_filters").select("*").eq("entity_type", "contact"),
    // Company definitions come back too: the list shows a region, which is a
    // field of the business rather than of the person.
    scoped(context, "custom_field_definitions")
      .select("*")
      .in("entity_type", ["contact", "company"]),
    scoped(context, "users").select("*").order("name"),
    scoped(context, "companies").select("id, name").order("name"),
    scoped(context, "field_options")
      .select("*")
      .in("entity_type", ["contact", "company"])
      .order("order"),
    /*
     * Tags are a join table, so a Tags column needs both halves. Two small
     * queries for the whole page rather than one per row — the alternative is
     * an embed on the contact query, which would pull the join on every request
     * whether the column is showing or not.
     */
    scoped(context, "tags").select("id, name, color").order("name"),
    scoped(context, "contact_tags").select("contact_id, tag_id"),
    // Only the fixed lists: a list that follows a filter has nothing to add to.
    scoped(context, "email_lists")
      .select("id, name")
      .is("saved_filter_id", null)
      .order("name"),
  ]);

  // Headline counts describe the whole book of contacts, not the filtered view,
  // so they stay stable while someone narrows the list below. Started here and
  // awaited after the list query so the two run concurrently.
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const live = () =>
    scoped(context, "contacts")
      .select("id", { count: "exact", head: true })
      .is("duplicate_of_id", null)
      // An admin can see deleted records, but they do not belong in a headline
      // count or a working list — only in the recycle bin.
      .is("deleted_at", null);
  const statsPromise = Promise.all([
    live(),
    live().gte("created_at", monthStart.toISOString()),
    live().eq("lifecycle_stage", "customer"),
    live().is("owner_id", null),
  ]);

  // A ?view=<id> link replays a saved filter; anything else comes from the URL.
  const viewId = typeof params.view === "string" ? params.view : null;
  const savedView = viewId
    ? ((savedFilters ?? []) as SavedFilterRow[]).find(
        (filter) => filter.id === viewId,
      )
    : undefined;

  const config = savedView
    ? parseFilterConfig(savedView.filter_json)
    : filterFromSearchParams(params);

  const ownerList = (owners ?? []) as UserRow[];
  const companyList = (companies ?? []) as Pick<CompanyRow, "id" | "name">[];

  const allDefinitions = (customFields ?? []) as CustomFieldDefinitionRow[];
  const allOptions = (fieldOptionRows ?? []) as FieldOptionRow[];

  const contactDefinitions = allDefinitions.filter(
    (field) => field.entity_type === "contact",
  );
  const contactOptions = allOptions.filter(
    (option) => option.entity_type === "contact",
  );
  const optionsFor = (key: string) =>
    contactOptions.filter((option) => option.field_key === key);

  /*
   * Region is a field of the company rather than the contact, so the column
   * finds it by name — the same lookup the companies list uses.
   */
  const regionField = findCompanyField(allDefinitions, "regions", "region");
  const regionOptions = regionField
    ? allOptions.filter(
        (option) =>
          option.entity_type === "company" &&
          option.field_key === regionField.key,
      )
    : [];

  const fields = fieldsFor(
    "contact",
    contactDefinitions,
    contactOptions,
  ).map((field) => {
    if (field.key === "owner_id") {
      return {
        ...field,
        options: ownerList.map((user) => ({
          value: user.id,
          label: user.name || user.email,
        })),
      };
    }
    if (field.key === "company_id") {
      return {
        ...field,
        options: companyList.map((company) => ({
          value: company.id,
          label: company.name,
        })),
      };
    }
    return field;
  });

  let query = scoped(context, "contacts")
    .select("*, companies(id, name, custom_fields)", { count: "exact" })
    // Merged-away records stay in the table as tombstones; the list shows survivors.
    .is("duplicate_of_id", null)
    .is("deleted_at", null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = applyFilter(query as any, config, "contact") as any;

  const { data: contacts, count, error } = await query.limit(PAGE_SIZE);
  const [totalStat, newThisMonth, customers, unassigned] = await statsPromise;
  const savedColumns = await readColumns("contact");

  const rows = (contacts ?? []) as (ContactRow & {
    companies: {
      id: string;
      name: string;
      custom_fields: Record<string, unknown>;
    } | null;
  })[];

  const ownerNames = new Map(
    ownerList.map((user) => [user.id, user.name || user.email]),
  );

  /* Tag ids to the tag, and each contact to the tags on it. */
  const tagsById = new Map(
    ((tagRows ?? []) as Pick<TagRow, "id" | "name" | "color">[]).map((tag) => [tag.id, tag]),
  );
  const tagsByContact = new Map<string, Pick<TagRow, "id" | "name" | "color">[]>();
  for (const link of (contactTagRows ?? []) as { contact_id: string; tag_id: string }[]) {
    const tag = tagsById.get(link.tag_id);
    if (!tag) continue;
    const list = tagsByContact.get(link.contact_id);
    if (list) list.push(tag);
    else tagsByContact.set(link.contact_id, [tag]);
  }
  /*
   * Region is not offered here. It belongs to the company, so setting it on a
   * selection of contacts would quietly edit their employers — including for
   * every other contact who works there. It is on the companies list instead.
   */
  const bulkFields = bulkFieldsFor("contact", {
    owners: ownerList.map((user) => ({
      value: user.id,
      label: user.name || user.email,
    })),
    companies: companyList.map((company) => ({
      value: company.id,
      label: company.name,
    })),
    customFields: contactDefinitions,
    fieldOptions: contactOptions,
  });

  /*
   * Headings come off the same field list the filter uses, so a stage grouped
   * as `lead` still reads "Lead" and an owner id still reads a name. See
   * labelFromFields.
   */
  const groups = groupRowsNested(
    rows,
    config.groupBy,
    config.subGroupBy,
    labelFromFields(fields),
  );

  /*
   * The columns this person has chosen, and how to draw each one. The
   * catalogue and the ordering rules are shared — see lib/table-columns — but
   * the cells stay here, where the lookups they need already are. A shared
   * renderer would mean threading owner names, option colours and the company
   * region field into it from three different pages.
   */
  const catalogue = columnCatalogue("contact", contactDefinitions);
  const columns = resolveColumns("contact", savedColumns, catalogue);

  // Checkbox, the chosen columns, and the call/email icons at the end.
  const COLUMNS = columns.length + 2;

  const cell = (
    contact: (typeof rows)[number],
    key: string,
  ): React.ReactNode => {
    const name = contactName(contact);

    switch (key) {
      case "name":
        return (
          <Link
            href={`/contacts/${contact.id}`}
            className="block truncate font-medium text-slate-900 hover:text-brand-700"
          >
            {name}
          </Link>
        );
      case "company":
        return contact.companies ? (
          <Link
            href={`/companies/${contact.companies.id}`}
            className="block truncate text-slate-600 hover:text-brand-700 hover:underline"
          >
            {contact.companies.name}
          </Link>
        ) : (
          <Empty />
        );
      case "email":
        return contact.email ? (
          <a href={`mailto:${contact.email}`} className="text-brand-700 hover:underline">
            {contact.email}
          </a>
        ) : (
          <Empty />
        );
      case "phone":
        return contact.phone ? (
          <span className="whitespace-nowrap text-slate-600">{contact.phone}</span>
        ) : (
          <Empty />
        );
      case "owner":
        return contact.owner_id ? (
          <span className="text-slate-600">{ownerNames.get(contact.owner_id) ?? "—"}</span>
        ) : (
          <Empty />
        );
      case "priority":
        return contact.priority ? (
          <OptionBadge
            value={contact.priority}
            color={optionColor(optionsFor("priority"), contact.priority)}
          />
        ) : (
          <Empty />
        );
      case "role_type":
        return <OptionBadges values={contact.role_type} options={optionsFor("role_type")} />;
      case "credibility":
        return contact.credibility ? (
          <OptionBadge
            value={contact.credibility}
            color={optionColor(optionsFor("credibility"), contact.credibility)}
          />
        ) : (
          <Empty />
        );
      case "tags": {
        /*
         * The tag's own colour, which an admin chose in Settings → Tags, so it
         * is an inline style rather than a class — Tailwind cannot see a hex
         * that only exists in the database. Tinted background, solid text, the
         * same shape every other badge on this row has.
         */
        const tags = tagsByContact.get(contact.id) ?? [];
        if (tags.length === 0) return <Empty />;
        return (
          <span className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag.id}
                className="badge"
                style={{ backgroundColor: `${tag.color}1f`, color: tag.color }}
              >
                {tag.name}
              </span>
            ))}
          </span>
        );
      }
      case "lifecycle_stage":
        // The badge the contact's own page uses. Every other column here with a
        // fixed vocabulary is a badge; this one was plain lowercase text.
        return contact.lifecycle_stage ? (
          <LifecycleBadge stage={contact.lifecycle_stage} />
        ) : (
          <Empty />
        );
      case "lead_score":
        return <span className="text-slate-600">{contact.lead_score ?? 0}</span>;
      case "source":
        return contact.source ? (
          <span className="text-slate-600">{contact.source}</span>
        ) : (
          <Empty />
        );
      case "job_title":
        return contact.job_title ? (
          <span className="block truncate text-slate-600">{contact.job_title}</span>
        ) : (
          <Empty />
        );
      case "region":
        // The company's, not the person's — a contact has no region of its own.
        return (
          <OptionBadges
            values={companyFieldValues(contact.companies, regionField)}
            options={regionOptions}
          />
        );
      case "created_at":
        return <span className="text-slate-600">{formatDay(contact.created_at)}</span>;
      default:
        return <CustomCell row={contact} columnKey={key} />;
    }
  };

  const contactRow = (contact: (typeof rows)[number]) => {
    const name = contactName(contact);
    return (
      <tr key={contact.id} className="transition-colors hover:bg-slate-50/70">
        <td>
          <SelectRow id={contact.id} label={`Select ${name}`} />
        </td>

        {columns.map((column) => (
          <td
            key={column.key}
            className={column.align === "right" ? "text-right" : undefined}
          >
            <div className="min-w-0 max-w-xs">{cell(contact, column.key)}</div>
          </td>
        ))}

        <td>
          <div className="flex items-center justify-end gap-1">
            {contact.phone && (
              <a
                // Stripped, like every other tel: link in the app: a stored
                // number may carry the spaces and dashes that make it
                // readable, and a space in a URI is not a dialable digit.
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
  };

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Manage your contacts"
        actions={
          <>
            <ColumnPicker
              entity="contact"
              catalogue={catalogue}
              selected={columns.map((column) => column.key)}
            />
            {context.canBulk && (
              <Link href="/settings/import" className="btn-secondary">
                <ImportIcon className="h-4 w-4" />
                Import
              </Link>
            )}
            {context.canWrite && (
              <Link href="/contacts/new" className="btn-primary">
                <PlusIcon className="h-4 w-4" />
                New contact
              </Link>
            )}
          </>
        }
      />

      {typeof params.error === "string" && <ErrorNote>{params.error}</ErrorNote>}
      {typeof params.ok === "string" && (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          {params.ok}
        </p>
      )}

      <StatGrid>
        <StatCard
          label="Total contacts"
          value={String(totalStat.count ?? 0)}
          icon={ContactsIcon}
          tone="blue"
        />
        <StatCard
          label="New this month"
          value={String(newThisMonth.count ?? 0)}
          icon={TrendingUpIcon}
          tone="brand"
          trend={
            (newThisMonth.count ?? 0) > 0
              ? { label: `+${newThisMonth.count}`, direction: "up" }
              : undefined
          }
        />
        <StatCard
          label="Customers"
          value={String(customers.count ?? 0)}
          icon={AwardIcon}
          tone="amber"
        />
        <StatCard
          label="Unassigned"
          value={String(unassigned.count ?? 0)}
          icon={AlertIcon}
          tone={(unassigned.count ?? 0) > 0 ? "red" : "violet"}
          href={(unassigned.count ?? 0) > 0 ? UNASSIGNED_VIEW : undefined}
        />
      </StatGrid>

      <FilterBar
        fields={fields}
        initial={config}
        savedFilters={(savedFilters ?? []) as SavedFilterRow[]}
        entityType="contact"
        currentUserId={context.user.id}
        canExport={context.canBulk}
        saveAction={saveFilter}
        deleteAction={deleteSavedFilter}
      />

      {error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error.message}
        </p>
      )}

      {/* Keeps the truncation warning visible: the list stops at PAGE_SIZE, and
          silently showing 200 of 900 would misrepresent the view. */}
      {count !== null && count !== undefined && rows.length > 0 && (
        <p className="mb-3 text-xs text-slate-500">
          {count} contact{count === 1 ? "" : "s"} match this view
          {count > PAGE_SIZE ? ` · showing the first ${PAGE_SIZE}` : ""}
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No contacts match this view"
          description="Adjust the filters, or add a contact to get started."
          action={
            <Link href="/contacts/new" className="btn-primary">
              New contact
            </Link>
          }
        />
      ) : (
        <BulkEdit entity="contact" fields={bulkFields} canDelete={context.canDelete}>
          <ConsentBar lists={(emailLists ?? []) as { id: string; name: string }[]} />
          <div className="space-y-8">
            {groups.map((group) => (
            <div key={group.key ?? "all"}>
              {config.groupBy && (
                <div className="group-header flex items-baseline justify-between gap-3">
                  <h2>{group.label}</h2>
                  <span className="badge bg-brand-100 text-brand-700">
                    {group.rows.length}
                  </span>
                </div>
              )}
              {/*
                The card starts here rather than around the heading, so the
                rounded corners land on the column header row. overflow-x is
                what makes the radius clip that row's fill; it was already
                here for wide tables.
              */}
              <div className="group-panel overflow-x-auto">
                <table className="table">
                  <thead>
                    {/*
                      Whatever this person chose, in their order. The defaults
                      answer "who is worth calling" rather than "when was this
                      typed in" — priority, role and credibility — and the
                      Columns button is how somebody who wants a different
                      question asked changes it.
                    */}
                    <tr>
                      <th className="w-10">
                        <SelectAll label="Select every contact shown" />
                      </th>
                      {columns.map((column) => (
                        <th
                          key={column.key}
                          className={column.align === "right" ? "text-right" : undefined}
                        >
                          {column.label}
                        </th>
                      ))}
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/*
                      With a sub-group, each one gets a heading row and then its
                      rows; without, the rows go straight in. Same table either
                      way, so the columns keep their widths.
                    */}
                    {(group.subGroups ?? [{ key: null, label: "", rows: group.rows }]).flatMap(
                      (sub) => [
                        ...(group.subGroups
                          ? [
                              <SubGroupRow
                                key={`sub-${sub.key ?? "none"}`}
                                label={sub.label}
                                count={sub.rows.length}
                                columns={COLUMNS}
                              />,
                            ]
                          : []),
                        ...sub.rows.map(contactRow),
                      ],
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            ))}
          </div>
        </BulkEdit>
      )}
    </>
  );
}
