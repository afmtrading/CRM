import Link from "next/link";

import { requireSession, scoped } from "@/lib/tenancy";
import {
  applyFilter,
  fieldsFor,
  filterFromSearchParams,
  groupRowsNested,
  overlappingGroupField,
  labelFromFields,
  parseFilterConfig,
  TAGS_FIELD_KEY,
} from "@/lib/filters";
import { contactName, formatDay } from "@/lib/format";
import { LIFECYCLE_LABELS } from "@/lib/field-options";
import { chosenValues } from "@/lib/custom-fields";
import { startOfMonthIn } from "@/lib/timezone";
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
import { CustomCell, Empty, OptionBadges, ReachActions } from "@/components/contact-cards";
import {
  EmptyState,
  ErrorNote,
  GroupOverlapNote,
  PageHeader,
  StatCard,
  StatGrid,
} from "@/components/ui";
import { CollapsibleGroup, CollapsibleSubGroup } from "@/components/collapsible";
import { InlineEdit, InlineText, type InlineOption } from "@/components/inline-edit";
import {
  AlertIcon,
  AwardIcon,
  ContactsIcon,
  ImportIcon,
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

/*
 * The lifecycle stages, for the cell that edits one.
 *
 * Not a field_options list — the stages are a column with a check constraint
 * on it, so the colours are named here to match the badge the record's own
 * page draws. The cell that uses this offers no way to empty it: a contact
 * always has a stage, "none" is `lead`, and the database whitelist refuses
 * `clear` on the column anyway.
 */
const LIFECYCLE_OPTIONS: InlineOption[] = [
  { value: "lead", label: LIFECYCLE_LABELS.lead, color: "slate" },
  { value: "qualified", label: LIFECYCLE_LABELS.qualified, color: "amber" },
  { value: "customer", label: LIFECYCLE_LABELS.customer, color: "green" },
  { value: "other", label: LIFECYCLE_LABELS.other, color: "slate" },
];

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
  //
  // The month begins on the organization's clock. The server runs in UTC, so a
  // contact added at nine on the evening of the 31st in Toronto had already
  // been counted against the following month.
  const monthStart = startOfMonthIn(context.organization.timezone);

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
  const tagList = (tagRows ?? []) as Pick<TagRow, "id" | "name" | "color">[];

  /*
   * Which tags each contact carries, as ids, before the query is built. A tag
   * condition becomes a predicate on `id` and there is nothing to build it from
   * once the rows have already come back — see tagPredicate.
   */
  const tagIdsByContact = new Map<string, string[]>();
  for (const link of (contactTagRows ?? []) as {
    contact_id: string;
    tag_id: string;
  }[]) {
    const list = tagIdsByContact.get(link.contact_id);
    if (list) list.push(link.tag_id);
    else tagIdsByContact.set(link.contact_id, [link.tag_id]);
  }

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
   * The same list, in the shape an editable cell wants: the value, the word to
   * show for it, and the colour an admin gave it in Settings → Fields, so the
   * menu offers exactly the badges the column is already drawing.
   *
   * Built once per field and handed to every row that shows it. React writes
   * an object it has already written as a back-reference, so one shared array
   * costs one copy in the payload while a fresh array per row costs two
   * hundred — which on the company picker below is the difference between
   * forty kilobytes and four megabytes.
   */
  const inlineOptionCache = new Map<string, InlineOption[]>();
  const inlineOptions = (key: string): InlineOption[] => {
    const built = inlineOptionCache.get(key);
    if (built) return built;

    const options = optionsFor(key).map((option) => ({
      value: option.value,
      label: option.value,
      color: option.color,
    }));
    inlineOptionCache.set(key, options);
    return options;
  };

  /** The people a record can be assigned to. Also built once — see above. */
  const ownerOptions: InlineOption[] = ownerList.map((user) => ({
    value: user.id,
    label: user.name || user.email,
  }));

  /*
   * Which cells can be changed from the list at all. Ownership is a manager's
   * decision wherever it is made — the record's own form does not render the
   * field for a rep either — and everything else follows plain write access.
   * The database checks both again; this only decides what is offered.
   */
  const canEditCell = context.canWrite;
  const canAssign = context.canManage;

  /*
   * The tags an organization has, as options. Their colours are hexes an admin
   * chose in Settings → Tags rather than one of the ten named ones, so they
   * ride as a swatch — see InlineOption.
   */
  const tagOptions: InlineOption[] = tagList.map((tag) => ({
    value: tag.id,
    label: tag.name,
    swatch: tag.color,
  }));

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

  /*
   * Every company, as options for the cell that moves a contact between them.
   * Each carries its own link, so the value in the cell stays clickable and
   * points at whichever company is chosen — see InlineOption.href.
   */
  const companyOptions: InlineOption[] = companyList.map((company) => ({
    value: company.id,
    label: company.name,
    href: `/companies/${company.id}`,
  }));
  const companyIds = new Set(companyList.map((company) => company.id));

  /*
   * …and the same list with this contact's own company guaranteed to be in it.
   *
   * The picker's list comes back from one query, and PostgREST caps how many
   * rows that returns. On a book of companies large enough to hit that cap, a
   * contact can be at one the list does not mention — and an option list
   * missing the value it is showing would draw a raw id where a name should
   * be. The copy only happens in that case.
   */
  const companyOptionsFor = (company: { id: string; name: string } | null) =>
    company && !companyIds.has(company.id)
      ? [
          { value: company.id, label: company.name, href: `/companies/${company.id}` },
          ...companyOptions,
        ]
      : companyOptions;

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
    /*
     * Tags are offered by id and read by name. A saved view that named them
     * would stop matching the moment somebody renamed one in Settings.
     */
    if (field.key === TAGS_FIELD_KEY) {
      return {
        ...field,
        options: tagList.map((tag) => ({ value: tag.id, label: tag.name })),
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
  query = applyFilter(query as any, config, "contact", undefined, tagIdsByContact) as any;

  const { data: contacts, count, error } = await query.limit(PAGE_SIZE);
  const [totalStat, newThisMonth, customers, unassigned] = await statsPromise;
  const savedColumns = await readColumns("contact");

  /*
   * Tags ride along on the row so the grouping can read them. They are not a
   * column, and groupRows has only the row to work from.
   */
  const rows = ((contacts ?? []) as (ContactRow & {
    companies: {
      id: string;
      name: string;
      custom_fields: Record<string, unknown>;
    } | null;
  })[]).map((contact) => ({
    ...contact,
    [TAGS_FIELD_KEY]: tagIdsByContact.get(contact.id) ?? [],
  }));

  /*
   * Which tags each contact carries is already `tagIdsByContact`, built above
   * for the filter. The cell draws them from the option list by id, so there
   * is no second map from contact to tag rows any more.
   */
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
  // Tags put a record in every group it is tagged with, so the counts add up
  // to more than the list. The page says so rather than looking wrong.
  const overlap = overlappingGroupField(fields, config.groupBy, config.subGroupBy);

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
        /*
         * Editable, and still a link. The company name goes on pointing at the
         * company; the chevron beside it is what opens the picker, so a column
         * people use to get somewhere did not become one they can only change.
         */
        return (
          <InlineEdit
            entity="contact"
            id={contact.id}
            field="company_id"
            fieldLabel="Company"
            values={contact.companies ? [contact.companies.id] : []}
            options={companyOptionsFor(contact.companies)}
            canEdit={canEditCell}
          />
        );
      /*
       * Typed where it is shown. The mailto and tel links are not lost with
       * the anchor — they are the two icons at the end of every row, which is
       * where somebody reaches for them anyway. What the cell is for is fixing
       * the address that bounced.
       */
      case "email":
        return (
          <InlineText
            entity="contact"
            id={contact.id}
            field="email"
            fieldLabel="Email"
            kind="email"
            value={contact.email ?? ""}
            display={
              contact.email ? (
                <span className="block truncate text-slate-600">{contact.email}</span>
              ) : (
                <Empty />
              )
            }
            canEdit={canEditCell}
          />
        );
      case "phone":
        return (
          <InlineText
            entity="contact"
            id={contact.id}
            field="phone"
            fieldLabel="Phone"
            kind="phone"
            value={contact.phone ?? ""}
            display={
              contact.phone ? (
                <span className="whitespace-nowrap text-slate-600">{contact.phone}</span>
              ) : (
                <Empty />
              )
            }
            canEdit={canEditCell}
          />
        );
      /*
       * Owner, priority, role type, credibility, lifecycle stage and any
       * custom list below: the cell is the editor. Click it, pick a value, and
       * it is written — see components/inline-edit. Those are exactly the
       * columns the database will accept a one-field change to, which is why a
       * name or an email address is still a link to the record rather than a
       * box to type in.
       */
      case "owner":
        return (
          <InlineEdit
            entity="contact"
            id={contact.id}
            field="owner_id"
            fieldLabel="Owner"
            values={contact.owner_id ? [contact.owner_id] : []}
            options={ownerOptions}
            canEdit={canAssign}
          />
        );
      case "priority":
        return (
          <InlineEdit
            entity="contact"
            id={contact.id}
            field="priority"
            fieldLabel="Priority"
            values={contact.priority ? [contact.priority] : []}
            options={inlineOptions("priority")}
            canEdit={canEditCell}
          />
        );
      case "role_type":
        return (
          <InlineEdit
            entity="contact"
            id={contact.id}
            field="role_type"
            fieldLabel="Role type"
            values={contact.role_type ?? []}
            options={inlineOptions("role_type")}
            multiple
            canEdit={canEditCell}
          />
        );
      case "credibility":
        return (
          <InlineEdit
            entity="contact"
            id={contact.id}
            field="credibility"
            fieldLabel="Credibility"
            values={contact.credibility ? [contact.credibility] : []}
            options={inlineOptions("credibility")}
            canEdit={canEditCell}
          />
        );
      case "tags":
        /*
         * The same menu the other vocabulary fields use, over a different
         * table: tags are a join rather than a column. Nobody reading a list
         * should have to know which of their record's words live where.
         */
        return (
          <InlineEdit
            as="tags"
            entity="contact"
            id={contact.id}
            field="tags"
            fieldLabel="Tags"
            values={tagIdsByContact.get(contact.id) ?? []}
            options={tagOptions}
            multiple
            canEdit={canEditCell}
          />
        );
      case "lifecycle_stage":
        return (
          <InlineEdit
            entity="contact"
            id={contact.id}
            field="lifecycle_stage"
            fieldLabel="Lifecycle stage"
            values={contact.lifecycle_stage ? [contact.lifecycle_stage] : []}
            options={LIFECYCLE_OPTIONS}
            clearable={false}
            canEdit={canEditCell}
          />
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
        return (
          <InlineText
            entity="contact"
            id={contact.id}
            field="job_title"
            fieldLabel="Job title"
            value={contact.job_title ?? ""}
            display={
              contact.job_title ? (
                <span className="block truncate text-slate-600">{contact.job_title}</span>
              ) : (
                <Empty />
              )
            }
            canEdit={canEditCell}
          />
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
      default: {
        /*
         * An organization's own fields. The ones with a list behind them are
         * editable in place like the built-in ones; a free-text or number
         * field is shown as it is stored, because there is nothing to pick
         * from and nothing here to validate a typed value against.
         */
        const definition = contactDefinitions.find(
          (candidate) => `custom_fields.${candidate.key}` === key,
        );

        if (
          definition &&
          (definition.field_type === "select" || definition.field_type === "multiselect")
        ) {
          return (
            <InlineEdit
              entity="contact"
              id={contact.id}
              field={key}
              fieldLabel={definition.label}
              values={chosenValues(contact.custom_fields?.[definition.key])}
              options={inlineOptions(definition.key)}
              multiple={definition.field_type === "multiselect"}
              canEdit={canEditCell}
            />
          );
        }

        return <CustomCell row={contact} columnKey={key} />;
      }
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
          <ReachActions phone={contact.phone} email={contact.email} label={name} />
        </td>
      </tr>
    );
  };

  return (
    <>
      <PageHeader
        title="Contacts"
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
          {overlap && <GroupOverlapNote label={overlap.label} />}
          <div className="space-y-8">
            {groups.map((group) => (
            <CollapsibleGroup
              key={group.key ?? "all"}
              scope="contact"
              id={group.key ?? "all"}
              /* No heading when the list is not grouped — and then nothing to fold. */
              label={config.groupBy ? group.label : undefined}
              summary={
                config.groupBy ? (
                  <span className="badge bg-brand-100 text-brand-700">
                    {group.rows.length}
                  </span>
                ) : undefined
              }
            >
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
                      With a sub-group, each one gets a band it can be folded
                      away by and then its rows; without, the rows go straight
                      in. Same table either way, so the columns keep their
                      widths.
                    */}
                    {group.subGroups
                      ? group.subGroups.map((sub) => (
                          <CollapsibleSubGroup
                            key={`sub-${sub.key ?? "none"}`}
                            scope="contact"
                            id={`${group.key ?? "all"}/${sub.key ?? "none"}`}
                            label={sub.label}
                            count={sub.rows.length}
                            columns={COLUMNS}
                          >
                            {sub.rows.map(contactRow)}
                          </CollapsibleSubGroup>
                        ))
                      : group.rows.map(contactRow)}
                  </tbody>
                </table>
              </div>
            </CollapsibleGroup>
            ))}
          </div>
        </BulkEdit>
      )}
    </>
  );
}
