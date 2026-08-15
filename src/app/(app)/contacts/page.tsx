import Link from "next/link";

import { requireSession, scoped } from "@/lib/tenancy";
import {
  applyFilter,
  fieldsFor,
  filterFromSearchParams,
  groupRowsNested,
  parseFilterConfig,
} from "@/lib/filters";
import { contactName } from "@/lib/format";
import type {
  FieldOptionRow,
  ContactRow,
  CompanyRow,
  CustomFieldDefinitionRow,
  SavedFilterRow,
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
import { ConsentBar } from "@/components/consent-bar";
import { FilterBar } from "@/components/filter-bar";
import {
  OptionBadge,
  OptionBadges,
  optionColor,
} from "@/components/contact-cards";
import {
  EmptyState,
  ErrorNote,
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
  const companyNames = new Map(
    companyList.map((company) => [company.id, company.name]),
  );

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
   * Resolving ids to names has to know which field it is looking at, now that
   * two of them can be in play at once — an owner id and a company id are both
   * uuids and one of them would otherwise be labelled with the other's names.
   */
  const groups = groupRowsNested(rows, config.groupBy, config.subGroupBy, (field, value) => {
    if (value === null) return "None";
    if (field === "owner_id") return ownerNames.get(value) ?? "Unknown user";
    if (field === "company_id") return companyNames.get(value) ?? "Unknown company";
    return value;
  });

  const COLUMNS = 8;

  /*
   * One row, named, because it is now rendered from two places: straight into
   * the table when there is no second level, and under a sub-group heading when
   * there is. Duplicating it is how the two drift apart.
   */
  const contactRow = (contact: (typeof rows)[number]) => {
    const name = contactName(contact);
    return (
      <tr key={contact.id} className="transition-colors hover:bg-slate-50/70">
        <td>
          <SelectRow id={contact.id} label={`Select ${name}`} />
        </td>
        {/* The company rides under the name rather than taking its own column
            — who someone is and who they work for read as one thing, and the
            row gets a column back for what they are worth. */}
        <td>
          <div className="min-w-0">
            <Link
              href={`/contacts/${contact.id}`}
              className="block truncate font-medium text-slate-900 hover:text-brand-700"
            >
              {name}
            </Link>
            {contact.companies ? (
              <Link
                href={`/companies/${contact.companies.id}`}
                className="block truncate text-xs text-slate-500 hover:text-brand-700 hover:underline"
              >
                {contact.companies.name}
              </Link>
            ) : (
              <span className="block truncate text-xs text-slate-400">
                No company
              </span>
            )}
          </div>
        </td>
        <td className="text-slate-600">
          {contact.owner_id ? (ownerNames.get(contact.owner_id) ?? "—") : "—"}
        </td>
        <td>
          {contact.priority ? (
            <OptionBadge
              value={contact.priority}
              color={optionColor(optionsFor("priority"), contact.priority)}
            />
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </td>
        <td>
          <OptionBadges
            values={contact.role_type}
            options={optionsFor("role_type")}
          />
        </td>
        <td>
          {contact.credibility ? (
            <OptionBadge
              value={contact.credibility}
              color={optionColor(optionsFor("credibility"), contact.credibility)}
            />
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </td>
        <td>
          <OptionBadges
            values={companyFieldValues(contact.companies, regionField)}
            options={regionOptions}
          />
        </td>
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
          <div className="space-y-6">
            {groups.map((group) => (
            <div key={group.key ?? "all"} className="card overflow-hidden">
              {config.groupBy && (
                <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                  <h2 className="text-sm font-semibold text-slate-900">
                    {group.label}
                  </h2>
                  <span className="badge bg-slate-100 text-slate-600">
                    {group.rows.length}
                  </span>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    {/*
                      The list answers "who is worth calling" rather than "when
                      was this typed in": priority, role and credibility are
                      what a rep sorts on, and the region is the company's, not
                      the person's. Email and lifecycle stage left the row —
                      the mail icon covers one, the record page the other.
                    */}
                    <tr>
                      <th className="w-10">
                        <SelectAll label="Select every contact shown" />
                      </th>
                      <th>Name</th>
                      <th>Owner</th>
                      <th>Priority</th>
                      <th>Role type</th>
                      <th>Credibility</th>
                      <th>Region</th>
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
