'use client'

import { useActionState, useMemo, useState } from 'react'
import Link from 'next/link'

import type {
  ContactCard,
  CustomFieldDefinitionRow,
  DealRow,
  FieldOptionRow,
  PipelineRow,
  StageRow,
  UserRow,
} from '@/lib/database.types'
import { CustomFieldInputs } from '@/components/form-fields'
import { SearchSelect } from '@/components/search-select'
import { CURRENCIES } from '@/lib/format'

import type { DealActionState } from './actions'

export function DealForm({
  action,
  deal,
  pipelines,
  stages,
  contacts,
  companies,
  owners,
  lossReasons,
  customFields,
  fieldOptions,
  defaultCurrency,
  defaultContactId,
  submitLabel,
}: {
  action: (state: DealActionState, formData: FormData) => Promise<DealActionState>
  deal?: DealRow
  pipelines: PipelineRow[]
  stages: StageRow[]
  /** `companyId` is what lets the contact list narrow to one company. */
  contacts: { id: string; label: string; companyId: string | null; companyName?: string | null }[]
  companies: { id: string; name: string }[]
  owners: UserRow[]
  /** The organization's own vocabulary for why a deal was lost. */
  lossReasons: string[]
  /** Organization-defined fields on a deal, and the values their selects offer. */
  customFields: CustomFieldDefinitionRow[]
  fieldOptions: FieldOptionRow[]
  defaultCurrency: string
  defaultContactId?: string
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as DealActionState)

  const initialStage = stages.find((stage) => stage.id === deal?.stage_id) ?? stages[0]
  const [pipelineId, setPipelineId] = useState(initialStage?.pipeline_id ?? pipelines[0]?.id ?? '')
  const [stageId, setStageId] = useState(initialStage?.id ?? '')
  const [status, setStatus] = useState(deal?.status ?? 'open')

  const [companyId, setCompanyId] = useState(deal?.company_id ?? '')
  const [contactId, setContactId] = useState(deal?.contact_id ?? defaultContactId ?? '')

  const byContact = useMemo(() => new Map(contacts.map((one) => [one.id, one])), [contacts])

  /*
   * Narrowed to the chosen company, plus whoever is already on the deal.
   *
   * That second half matters on an edit: a deal saved before the contact moved
   * companies would otherwise open with its own contact missing from the list,
   * and saving would quietly drop them.
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

  const custom = (deal?.custom_fields ?? {}) as Record<string, unknown>
  const onCard = (card: ContactCard) => customFields.filter((field) => field.card === card)
  const additional = onCard('additional')

  const pipelineStages = stages.filter((stage) => stage.pipeline_id === pipelineId)
  const selectedStage = stages.find((stage) => stage.id === stageId)

  return (
    <form action={formAction} className="space-y-4">
      {deal && <input type="hidden" name="id" value={deal.id} />}

      {state.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Saved.
        </p>
      )}

      <div className="card grid gap-4 p-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="name">
            Deal name
          </label>
          <input id="name" name="name" required className="input" defaultValue={deal?.name ?? ''} />
        </div>

        <div>
          <label className="label" htmlFor="pipeline">
            Pipeline
          </label>
          <select
            id="pipeline"
            className="input"
            value={pipelineId}
            onChange={(event) => {
              setPipelineId(event.target.value)
              const first = stages.find((stage) => stage.pipeline_id === event.target.value)
              setStageId(first?.id ?? '')
            }}
          >
            {pipelines.map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="stage_id">
            Stage
          </label>
          <select
            id="stage_id"
            name="stage_id"
            required
            className="input"
            value={stageId}
            onChange={(event) => setStageId(event.target.value)}
          >
            {pipelineStages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="value">
            Value
          </label>
          <input
            id="value"
            name="value"
            type="number"
            step="0.01"
            min="0"
            className="input"
            defaultValue={deal?.value ?? 0}
          />
          {deal?.value_source === 'products' && (
            <p className="mt-1 text-xs text-slate-400">
              This deal follows its line items. Changing the number here takes it off them.
            </p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="currency">
            Currency
          </label>
          <select
            id="currency"
            name="currency"
            className="input"
            defaultValue={deal?.currency ?? defaultCurrency}
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="probability">
            Probability (%)
          </label>
          <input
            id="probability"
            name="probability"
            type="number"
            min="0"
            max="100"
            className="input"
            placeholder={
              selectedStage ? `Stage default: ${Math.round(selectedStage.default_probability * 100)}` : ''
            }
            defaultValue={
              deal?.probability_overridden ? Math.round((deal?.probability ?? 0) * 100) : ''
            }
          />
          <p className="mt-1 text-xs text-slate-400">
            Leave blank to follow the stage default — moving the deal between stages then keeps it in
            step automatically.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="status">
            Status
          </label>
          <select
            id="status"
            name="status"
            className="input"
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </select>
          {status !== 'open' && (
            <p className="mt-1 text-xs text-slate-400">
              Moving the deal into a closing stage does this on its own.
            </p>
          )}
        </div>

        {/*
          Only on a lost deal, and only worth asking for at the moment it is
          marked lost. A "why" collected weeks later is a guess, and a "why" on
          a won deal is nothing at all.
        */}
        {status === 'lost' && (
          <div>
            <label className="label" htmlFor="loss_reason">
              Why was it lost?
            </label>
            <input
              id="loss_reason"
              name="loss_reason"
              list="loss-reasons"
              className="input"
              maxLength={120}
              defaultValue={deal?.loss_reason ?? ''}
              placeholder="Price, timing, lost to a competitor…"
            />
            <datalist id="loss-reasons">
              {lossReasons.map((reason) => (
                <option key={reason} value={reason} />
              ))}
            </datalist>
            <p className="mt-1 text-xs text-slate-400">
              Pick one of the organization&rsquo;s reasons or type your own. Admins keep the list in
              Settings &rarr; Fields.
            </p>
          </div>
        )}

        <div>
          <label className="label" htmlFor="expected_close_date">
            Expected close date
          </label>
          <input
            id="expected_close_date"
            name="expected_close_date"
            type="date"
            className="input"
            defaultValue={deal?.expected_close_date ?? ''}
          />
        </div>

        {/*
          Company first, then the people at it. The other order works but reads
          backwards: picking a person and then being told which company they
          belong to is the app repeating something you just chose.
        */}
        <div>
          <label className="label" htmlFor="deal-company">
            Company
          </label>
          <SearchSelect
            id="deal-company"
            name="company_id"
            options={companies.map((company) => ({ id: company.id, label: company.name }))}
            value={companyId}
            onChange={(next) => {
              setCompanyId(next)
              // A contact who does not work there cannot stay selected. Silent
              // would be worse: the deal would save against a person the
              // company list says has nothing to do with it.
              if (next && contactId && byContact.get(contactId)?.companyId !== next) {
                setContactId('')
              }
            }}
            placeholder="Search companies…"
          />
        </div>

        <div>
          <label className="label" htmlFor="deal-contact">
            Contact
          </label>
          <SearchSelect
            id="deal-contact"
            name="contact_id"
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

        <div>
          <label className="label" htmlFor="owner_id">
            Owner
          </label>
          <select id="owner_id" name="owner_id" className="input" defaultValue={deal?.owner_id ?? ''}>
            <option value="">—</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name || owner.email}
              </option>
            ))}
          </select>
        </div>

        {/* Whatever an admin put on the Details card, in the order they arranged. */}
        <CustomFieldInputs fields={onCard('details')} values={custom} fieldOptions={fieldOptions} />

        {/*
          What the deal is actually about, in the same markdown the contact and
          company cards use — so the note reads the same wherever it is written
          and there is one renderer rather than two.
        */}
        <div className="sm:col-span-2">
          <label className="label" htmlFor="notes">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={8}
            maxLength={20000}
            className="input font-normal"
            defaultValue={deal?.notes ?? ''}
            placeholder={'What is this deal about?\n\n- **bold**, *italic*, [links](https://…)\n- bullets and 1. numbered lists\n- # headings'}
          />
          <p className="mt-1 text-xs text-slate-400">
            Markdown: **bold**, *italic*, `#` headings, `-` bullets, `1.` numbers, [links](url).
          </p>
        </div>
      </div>

      {/*
        A second card, drawn only when there is something to put in it: an empty
        "Additional info" heading on every deal would be furniture.
      */}
      {additional.length > 0 && (
        <div className="card grid gap-4 p-4 sm:grid-cols-2">
          <h2 className="sm:col-span-2 text-sm font-semibold text-slate-900">Additional info</h2>
          <CustomFieldInputs fields={additional} values={custom} fieldOptions={fieldOptions} />
        </div>
      )}

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </button>
        <Link href={deal ? `/deals/${deal.id}` : '/deals'} className="btn-secondary">
          Cancel
        </Link>
      </div>
    </form>
  )
}
