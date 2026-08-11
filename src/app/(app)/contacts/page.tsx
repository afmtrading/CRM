import Link from "next/link";

import { requireSession, scoped } from "@/lib/tenancy";
import {
  applyFilter,
  fieldsFor,
  filterFromSearchParams,
  groupRows,
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
import { FilterBar } from "@/components/filter-bar";
import {
  OptionBadge,
  OptionBadges,
  optionColor,
} from "@/components/contact-cards";
import {
  Avatar,
  EmptyState,
  PageHeader,
  StatCard,
  StatGrid,
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
   * Region is a custom field on the company, so the column has to find it by
   * name rather than by column. Matched the way the migration that created the
   * card matched it — if a business calls the field something else entirely,
   * the column stays empty rather than guessing at a different field.
   */
  const regionField = allDefinitions.find(
    (field) =>
      field.entity_type === "company" &&
      (["regions", "region"].includes(field.label.toLowerCase()) ||
        ["regions", "region"].includes(field.key.toLowerCase())),
  );
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

  /** The regions on a contact's employer, as a list whichever way it is stored. */
  const regionsOf = (company: { custom_fields: Record<string, unknown> } | null) => {
    if (!company || !regionField) return [];
    const raw = company.custom_fields?.[regionField.key];
    if (raw === undefined || raw === null || raw === "") return [];
    return Array.isArray(raw) ? raw.map(String) : [String(raw)];
  };

  const ownerNames = new Map(
    ownerList.map((user) => [user.id, user.name || user.email]),
  );
  const companyNames = new Map(
    companyList.map((company) => [company.id, company.name]),
  );

  const groups = groupRows(rows, config.groupBy, (value) => {
    if (value === null) return "None";
    if (config.groupBy === "owner_id")
      return ownerNames.get(value) ?? "Unknown user";
    if (config.groupBy === "company_id")
      return companyNames.get(value) ?? "Unknown company";
    return value;
  });

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
                      <th>Name</th>
                      <th>Priority</th>
                      <th>Role type</th>
                      <th>Credibility</th>
                      <th>Region</th>
                      <th>Owner</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((contact) => {
                      const name = contactName(contact);
                      return (
                        <tr
                          key={contact.id}
                          className="transition-colors hover:bg-slate-50/70"
                        >
                          {/* The company rides under the name rather than
                              taking its own column — who someone is and who
                              they work for read as one thing, and the row gets
                              a column back for what they are worth. */}
                          <td>
                            <div className="flex items-center gap-3">
                              <Avatar name={name} />
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
                            </div>
                          </td>
                          <td>
                            {contact.priority ? (
                              <OptionBadge
                                value={contact.priority}
                                color={optionColor(
                                  optionsFor("priority"),
                                  contact.priority,
                                )}
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
                                color={optionColor(
                                  optionsFor("credibility"),
                                  contact.credibility,
                                )}
                              />
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td>
                            <OptionBadges
                              values={regionsOf(contact.companies)}
                              options={regionOptions}
                            />
                          </td>
                          <td className="text-slate-600">
                            {contact.owner_id
                              ? (ownerNames.get(contact.owner_id) ?? "—")
                              : "—"}
                          </td>
                          <td>
                            <div className="flex items-center justify-end gap-1">
                              {contact.phone && (
                                <a
                                  href={`tel:${contact.phone}`}
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
            </div>
          ))}
        </div>
      )}
    </>
  );
}
