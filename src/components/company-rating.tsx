import type { CustomFieldDefinitionRow, FieldOptionRow } from '@/lib/database.types'
import { companyFieldValues, findCompanyField } from '@/lib/company-fields'
import { optionsForField } from '@/lib/field-options'

import {
  CustomFieldValues,
  Empty,
  Field,
  FieldRow,
  OptionBadges,
} from '@/components/contact-cards'

/**
 * What a company holds that this card reads. Deliberately a shape rather than
 * CompanyRow: the contact page selects the columns it needs from an embedded
 * join and does not have the rest of the row to give.
 */
export interface CompanyRating {
  priority: string | null
  specialty_market: string[] | null
  stock_type: string[] | null
  customer_type: string[] | null
  based_in: string | null
  sells_in: string[] | null
  custom_fields: Record<string, unknown> | null
}

/**
 * The Company Rating card's rows, wherever it appears.
 *
 * It appears twice — on the company itself, and mirrored onto every contact who
 * works there — and the two had drifted: the mirror was missing priority, base
 * country and where the business sells, and called merchandise "Market". A card
 * that says one thing on one page and another on the next is worse than either
 * version, because a reader cannot tell which one is the record.
 *
 * So the rows live here and both pages render them. Each page keeps its own
 * Section around this, because the headers genuinely differ: the company's card
 * is the record, and the contact's carries a link to it.
 *
 * The caller supplies `placeName` rather than this reaching for the country
 * table itself — the pages already load it for their other geography, and a
 * component that fetched would make this a server-only thing for no gain.
 */
export function CompanyRatingRows({
  company,
  options,
  customFields,
  placeName,
}: {
  company: CompanyRating
  /** Every option row the page loaded; the company's are picked out here. */
  options: FieldOptionRow[]
  /** The company's custom fields filed under the rating card. */
  customFields: CustomFieldDefinitionRow[]
  /** A country or region code as a person reads it. See lib/geography. */
  placeName: (code: string) => string
}) {
  const optionsFor = (key: string) => optionsForField(options, 'company', key)

  /*
   * Size sits beside the base country rather than down among the custom fields,
   * because "a big US buyer" is one thought and reading it meant jumping the
   * length of the card. It is still whatever field this organization defined —
   * matched by name, not assumed — and it is taken out of the list below so it
   * does not appear twice.
   */
  const sizeField = findCompanyField(customFields, 'size')
  const sizeValues = companyFieldValues(company, sizeField)
  const rest = customFields.filter((field) => field.id !== sizeField?.id)

  const sellsIn = company.sells_in ?? []

  return (
    <>
      {/* First on the card, because how much an account matters is the thing
          somebody scans a record for before anything else. */}
      <FieldRow columns={1}>
        <Field label="Priority">
          {company.priority ? (
            <OptionBadges values={[company.priority]} options={optionsFor('priority')} />
          ) : (
            <Empty />
          )}
        </Field>
      </FieldRow>
      <FieldRow columns={1}>
        <Field label="Merchandise">
          <OptionBadges
            values={company.specialty_market ?? []}
            options={optionsFor('specialty_market')}
          />
        </Field>
      </FieldRow>
      {/*
        Between the two it belongs between: what category of goods a business
        deals in, then what condition they arrive in, then what kind of business
        it is.
      */}
      <FieldRow columns={1}>
        <Field label="Stock type">
          <OptionBadges values={company.stock_type ?? []} options={optionsFor('stock_type')} />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Base Country">
          {company.based_in ? placeName(company.based_in) : <Empty />}
        </Field>
        {sizeField ? (
          <Field label={sizeField.label}>
            {sizeValues.length > 0 ? (
              <OptionBadges
                values={sizeValues}
                options={options.filter(
                  (option) =>
                    option.entity_type === 'company' && option.field_key === sizeField.key,
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
      {/*
        Names, not codes. The card used to print the stored codes on the grounds
        that "CA · US · MX" reads at a glance — but it reads at a glance only to
        somebody who already knows the codes, and every list in the app spells
        these out. A card that disagrees with the list it was opened from is the
        thing worth avoiding.
      */}
      <FieldRow columns={1}>
        <Field label="Sells To">
          {sellsIn.length > 0 ? sellsIn.map(placeName).join(' · ') : <Empty />}
        </Field>
      </FieldRow>
      <FieldRow columns={1}>
        <Field label="Company type">
          <OptionBadges values={company.customer_type ?? []} options={optionsFor('customer_type')} />
        </Field>
      </FieldRow>
      <CustomFieldValues
        fields={rest}
        values={company.custom_fields ?? {}}
        fieldOptions={options}
      />
    </>
  )
}
