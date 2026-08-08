import Link from "next/link";

import { requireSession, scoped } from "@/lib/tenancy";
import {
  applyFilter,
  fieldsFor,
  filterFromSearchParams,
  groupRows,
  parseFilterConfig,
} from "@/lib/filters";
import { contactName, formatDate } from "@/lib/format";
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
  Avatar,
  EmptyState,
  LifecycleBadge,
  PageHeader,
  ScoreMeter,
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
    { data: contactFieldOptions },
  ] = await Promise.all([
    scoped(context, "saved_filters").select("*").eq("entity_type", "contact"),
    scoped(context, "custom_field_definitions")
      .select("*")
      .eq("entity_type", "contact"),
    scoped(context, "users").select("*").order("name"),
    scoped(context, "companies").select("id, name").order("name"),
    scoped(context, "field_options")
      .select("*")
      .eq("entity_type", "contact")
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

  const fields = fieldsFor(
    "contact",
    (customFields ?? []) as CustomFieldDefinitionRow[],
    (contactFieldOptions ?? []) as FieldOptionRow[],
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
    .select("*, companies(id, name)", { count: "exact" })
    // Merged-away records stay in the table as tombstones; the list shows survivors.
    .is("duplicate_of_id", null)
    .is("deleted_at", null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = applyFilter(query as any, config, "contact") as any;

  const { data: contacts, count, error } = await query.limit(PAGE_SIZE);
  const [totalStat, newThisMonth, customers, unassigned] = await statsPromise;

  const rows = (contacts ?? []) as (ContactRow & {
    companies: { id: string; name: string } | null;
  })[];

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
                    <tr>
                      <th>Name</th>
                      <th>Company</th>
                      <th>Stage</th>
                      <th>Score</th>
                      <th>Owner</th>
                      <th>Created</th>
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
                          {/* Email and phone ride under the name rather than
                              taking their own columns — the row stays scannable
                              and the contact details stay together. */}
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
                                <span className="block truncate text-xs text-slate-500">
                                  {contact.email ??
                                    contact.phone ??
                                    "No contact details"}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="text-slate-600">
                            {contact.companies ? (
                              <Link
                                href={`/companies/${contact.companies.id}`}
                                className="hover:text-brand-700 hover:underline"
                              >
                                {contact.companies.name}
                              </Link>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            <LifecycleBadge stage={contact.lifecycle_stage} />
                          </td>
                          <td>
                            <ScoreMeter score={contact.lead_score} />
                          </td>
                          <td className="text-slate-600">
                            {contact.owner_id
                              ? (ownerNames.get(contact.owner_id) ?? "—")
                              : "—"}
                          </td>
                          <td className="text-slate-500">
                            {formatDate(contact.created_at)}
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
