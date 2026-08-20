import Link from 'next/link'

import { contactName, formatDay } from '@/lib/format'
import { optionsForField, renderMarkdown, safeUrl, socialUrl } from '@/lib/field-options'
import type {
  CompanyAddress,
  CompanyRow,
  ContactLink,
  ContactRow,
  CustomFieldDefinitionRow,
  DealRow,
  FieldOptionRow,
} from '@/lib/database.types'
import { MailIcon, PhoneIcon } from '@/components/icons'
import { Money } from '@/components/money'
import { DealStatusBadge } from '@/components/ui'
import {
  ContactMethod,
  CustomFieldValues,
  Empty,
  ExternalLink,
  Field,
  FieldRow,
  OptionBadges,
} from '@/components/contact-cards'

/**
 * The cards a company record is made of, wherever that record is shown.
 *
 * It is shown in two places: on the company itself, and on the marketplace
 * page for a company that is also a channel — a marketplace *is* a company, so
 * the same facts belong on both. Company Rating learned this lesson first (see
 * company-rating.tsx): two copies of a card drift, and a card that says one
 * thing on one page and another on the next is worse than either version,
 * because a reader cannot tell which one is the record.
 *
 * So the rows and the tables live here and both pages render them. Each page
 * keeps its own `Section` around them, because the headers genuinely differ —
 * a "New contact" button belongs on the company's own page, and the
 * marketplace's cards are a view of a record kept elsewhere.
 *
 * Everything here is a server component. `userName` is passed in as a function
 * rather than a map for that reason, and because both pages already have one.
 */

/* -------------------------------------------------------------------------- */
/* Company info                                                               */
/* -------------------------------------------------------------------------- */

export function CompanyInfoRows({
  company,
  options,
  customFields,
  contactCount,
}: {
  company: CompanyRow
  /** Every option row the page loaded; the company's are picked out here. */
  options: FieldOptionRow[]
  /** The company's custom fields filed under the details card. */
  customFields: CustomFieldDefinitionRow[]
  /** Shown as the last field — see the note below on why it rides along. */
  contactCount: number
}) {
  const website = safeUrl(company.domain)
  const addresses = Array.isArray(company.addresses) ? (company.addresses as CompanyAddress[]) : []

  return (
    <>
      <FieldRow>
        <Field label="Company name">{company.name}</Field>
        <Field label="Website">
          <ExternalLink url={website} />
        </Field>
      </FieldRow>
      {/* Owner is in this card's header, as on a contact. */}
      <FieldRow>
        <Field label="Company phone">
          <ContactMethod value={company.phone} kind="phone" label={company.name} />
        </Field>
        <Field label="Company email">
          <ContactMethod value={company.email} kind="email" label={company.name} />
        </Field>
      </FieldRow>
      {/* Specialty market and company type are on Company Rating — what a
          business is, rather than how to reach it. */}
      {/*
        Contacts rides along as the last field rather than a row of its own near
        the top. A headcount is what you check after knowing how to reach the
        business, and passed as `trailing` it lands beside the last custom field
        instead of taking a half-empty row under the name.
      */}
      <CustomFieldValues
        fields={customFields}
        values={(company.custom_fields ?? {}) as Record<string, unknown>}
        fieldOptions={options}
        trailing={<Field label="Contacts">{contactCount}</Field>}
      />

      {addresses.length > 0 && (
        <FieldRow columns={1}>
          <div>
            <dt className="text-xs font-medium text-slate-500">Addresses</dt>
            <dd className="mt-1 grid gap-3 sm:grid-cols-2">
              {addresses.map((entry, index) => (
                <div key={`${entry.label}-${index}`} className="rounded-xl bg-slate-50 p-3">
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
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Digital                                                                    */
/* -------------------------------------------------------------------------- */

export function CompanyDigitalRows({
  company,
  options,
  customFields,
}: {
  company: CompanyRow
  options: FieldOptionRow[]
  /** The company's custom fields filed under the digital card. */
  customFields: CustomFieldDefinitionRow[]
}) {
  const extraLinks = Array.isArray(company.links) ? (company.links as ContactLink[]) : []

  /*
   * No website field here: it is the first thing in Company info, and a value
   * repeated in two cards is a value that can look like it disagrees with
   * itself. This card is the social profiles.
   */
  return (
    <>
      <FieldRow columns={1}>
        <Field label="LinkedIn">
          <ExternalLink url={socialUrl('linkedin', company.linkedin)} />
        </Field>
      </FieldRow>
      <FieldRow columns={1}>
        <Field label="Facebook">
          <ExternalLink url={socialUrl('facebook', company.facebook)} />
        </Field>
      </FieldRow>
      <FieldRow columns={1}>
        <Field label="Instagram">
          <ExternalLink url={socialUrl('instagram', company.instagram)} />
        </Field>
      </FieldRow>
      <FieldRow columns={1}>
        <Field label="TikTok">
          <ExternalLink url={socialUrl('tiktok', company.tiktok)} />
        </Field>
      </FieldRow>
      <FieldRow columns={1}>
        <Field label="X (Twitter)">
          <ExternalLink url={socialUrl('x_twitter', company.x_twitter)} />
        </Field>
      </FieldRow>
      <FieldRow columns={1}>
        <Field label="YouTube">
          <ExternalLink url={socialUrl('youtube', company.youtube)} />
        </Field>
      </FieldRow>
      <CustomFieldValues
        fields={customFields}
        values={(company.custom_fields ?? {}) as Record<string, unknown>}
        fieldOptions={options}
        columns={1}
      />

      {extraLinks.length > 0 && (
        <FieldRow columns={1}>
          <div>
            <dt className="text-xs font-medium text-slate-500">Other links</dt>
            <dd className="mt-1 space-y-1 text-sm">
              {extraLinks.map((link, index) => (
                <div key={`${link.url}-${index}`}>
                  <ExternalLink url={safeUrl(link.url)} label={link.label || undefined} />
                </div>
              ))}
            </dd>
          </div>
        </FieldRow>
      )}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Additional info                                                            */
/* -------------------------------------------------------------------------- */

export function CompanyAdditionalRows({
  company,
  options,
  customFields,
}: {
  company: CompanyRow
  options: FieldOptionRow[]
  /** The company's custom fields filed under the additional card. */
  customFields: CustomFieldDefinitionRow[]
}) {
  const notesHtml = renderMarkdown(company.notes)

  return (
    <>
      <CustomFieldValues
        fields={customFields}
        values={(company.custom_fields ?? {}) as Record<string, unknown>}
        fieldOptions={options}
        columns={1}
      />
      <FieldRow columns={1}>
        <Field label="Notes">
          {notesHtml ? (
            <div
              className="space-y-2 leading-relaxed text-slate-700"
              // Safe by construction: renderMarkdown escapes the stored text
              // before applying formatting.
              dangerouslySetInnerHTML={{ __html: notesHtml }}
            />
          ) : (
            <Empty />
          )}
        </Field>
      </FieldRow>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* The people, and what is being sold to them                                 */
/* -------------------------------------------------------------------------- */

export function CompanyContactsTable({
  contacts,
  options,
  emptyMessage = 'No contacts at this company yet.',
}: {
  contacts: ContactRow[]
  options: FieldOptionRow[]
  /** Said instead of the table when there is nobody on file. */
  emptyMessage?: React.ReactNode
}) {
  const optionsFor = (key: string) => optionsForField(options, 'contact', key)

  if (contacts.length === 0) {
    return <p className="text-sm text-slate-500">{emptyMessage}</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Job title</th>
            {/*
              Priority, role and credibility rather than stage and lead score.
              On a company's own page the question is who to call and how much
              weight to give them, which is what these three answer; the stage
              is about a pipeline this table is not showing.
            */}
            <th>Priority</th>
            <th>Role type</th>
            <th>Credibility</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((contact) => {
            const name = contactName(contact)
            return (
              <tr key={contact.id} className="transition-colors hover:bg-slate-50/70">
                <td>
                  <Link
                    href={`/contacts/${contact.id}`}
                    className="block truncate font-medium text-slate-900 hover:text-brand-700"
                  >
                    {name}
                  </Link>
                </td>
                <td className="text-slate-600">{contact.job_title ?? '—'}</td>
                {/* OptionBadges draws the dash itself when the list is empty,
                    which is why none of these three needs a conditional. */}
                <td>
                  <OptionBadges
                    values={contact.priority ? [contact.priority] : []}
                    options={optionsFor('priority')}
                  />
                </td>
                <td>
                  <OptionBadges values={contact.role_type} options={optionsFor('role_type')} />
                </td>
                <td>
                  <OptionBadges
                    values={contact.credibility ? [contact.credibility] : []}
                    options={optionsFor('credibility')}
                  />
                </td>
                {/* No email column: the icon does the job it was doing, and the
                    row gets the space back. */}
                <td>
                  <div className="flex items-center justify-end gap-1">
                    {contact.phone && (
                      <a
                        // Stripped, like every other tel: link in the app: a
                        // stored number may carry the spaces and dashes that
                        // make it readable, and a space is not a dialable digit.
                        href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}
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
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export type CompanyDeal = DealRow & {
  stages: { name: string } | null
  contacts: { id: string; first_name: string; last_name: string } | null
}

export function CompanyDealsTable({
  deals,
  userName,
  emptyMessage = 'No deals linked to this company.',
}: {
  deals: CompanyDeal[]
  /** A user id as a person reads it. Both pages already load the user list. */
  userName: (userId: string | null) => string | null
  emptyMessage?: React.ReactNode
}) {
  if (deals.length === 0) {
    return <p className="text-sm text-slate-500">{emptyMessage}</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Deal</th>
            {/*
              Who it is with and who is running it. On a company with several
              open deals those are the two things that tell them apart, and
              both meant opening each deal to find out.
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
          {deals.map((deal) => (
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
              <td className="text-slate-600">{userName(deal.owner_id) ?? <Empty />}</td>
              <td>{deal.stages?.name ?? '—'}</td>
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
  )
}
