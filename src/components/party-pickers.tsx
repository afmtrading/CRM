'use client'

import { useMemo, useState } from 'react'

import { SearchSelect } from '@/components/search-select'

/**
 * A company, and then the people at it.
 *
 * Two searchable selects that know about each other: choosing a company
 * narrows the contact list to whoever works there. Company first, because the
 * other order reads backwards — picking a person and then being told which
 * company they belong to is the app repeating something you just chose.
 *
 * Written once and used by the deal form and the sales order, which asked the
 * same question of the same two tables and had it answered by a searchable
 * pair in one place and a pair of raw <select>s in the other.
 */

export interface PickerContact {
  id: string
  label: string
  /** What lets the list narrow. Null for a contact at no company. */
  companyId: string | null
  /** Shown under the name while no company is chosen, so a name has context. */
  companyName?: string | null
}

export function CompanyContactPickers({
  companies,
  contacts,
  defaultCompanyId = '',
  defaultContactId = '',
  companyName = 'company_id',
  contactName = 'contact_id',
  idPrefix = 'party',
  labels = { company: 'Company', contact: 'Contact' },
}: {
  companies: { id: string; name: string }[]
  contacts: PickerContact[]
  defaultCompanyId?: string
  defaultContactId?: string
  /** The form fields these post as, for a form that names them differently. */
  companyName?: string
  contactName?: string
  /** Keeps the two label/for pairs unique when a page renders more than one. */
  idPrefix?: string
  labels?: { company: string; contact: string }
}) {
  const [companyId, setCompanyId] = useState(defaultCompanyId)
  const [contactId, setContactId] = useState(defaultContactId)

  const byContact = useMemo(() => new Map(contacts.map((one) => [one.id, one])), [contacts])

  /*
   * Narrowed to the chosen company, plus whoever is already on the record.
   *
   * That second half matters on an edit: a record saved before the contact
   * moved companies would otherwise open with its own contact missing from the
   * list, and saving would quietly drop them.
   */
  const contactOptions = useMemo(() => {
    const list = companyId
      ? contacts.filter((one) => one.companyId === companyId || one.id === contactId)
      : contacts
    return list.map((one) => ({
      id: one.id,
      label: one.label,
      hint: companyId ? undefined : (one.companyName ?? undefined),
    }))
  }, [contacts, companyId, contactId])

  return (
    <>
      <div>
        <label className="label" htmlFor={`${idPrefix}-company`}>
          {labels.company}
        </label>
        <SearchSelect
          id={`${idPrefix}-company`}
          name={companyName}
          options={companies.map((company) => ({ id: company.id, label: company.name }))}
          value={companyId}
          onChange={(next) => {
            setCompanyId(next)
            /*
             * A contact who does not work there cannot stay selected. Silent
             * would be worse: the record would save against a person the
             * company list says has nothing to do with it.
             */
            if (next && contactId && byContact.get(contactId)?.companyId !== next) {
              setContactId('')
            }
          }}
          placeholder="Search companies…"
        />
      </div>

      <div>
        <label className="label" htmlFor={`${idPrefix}-contact`}>
          {labels.contact}
        </label>
        <SearchSelect
          id={`${idPrefix}-contact`}
          name={contactName}
          options={contactOptions}
          value={contactId}
          onChange={setContactId}
          placeholder={companyId ? 'Search people there…' : 'Search contacts…'}
        />
        {companyId && (
          <p className="mt-1 text-xs text-slate-400">
            {contactOptions.length === 0
              ? 'Nobody is on file at this company yet.'
              : `The ${contactOptions.length} ${
                  contactOptions.length === 1 ? 'person' : 'people'
                } on file at this company.`}
          </p>
        )}
      </div>
    </>
  )
}
