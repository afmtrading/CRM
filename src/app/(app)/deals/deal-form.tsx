'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'

import type { DealRow, PipelineRow, StageRow, UserRow } from '@/lib/database.types'

import type { DealActionState } from './actions'

export function DealForm({
  action,
  deal,
  pipelines,
  stages,
  contacts,
  companies,
  owners,
  defaultCurrency,
  defaultContactId,
  submitLabel,
}: {
  action: (state: DealActionState, formData: FormData) => Promise<DealActionState>
  deal?: DealRow
  pipelines: PipelineRow[]
  stages: StageRow[]
  contacts: { id: string; label: string }[]
  companies: { id: string; name: string }[]
  owners: UserRow[]
  defaultCurrency: string
  defaultContactId?: string
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as DealActionState)

  const initialStage = stages.find((stage) => stage.id === deal?.stage_id) ?? stages[0]
  const [pipelineId, setPipelineId] = useState(initialStage?.pipeline_id ?? pipelines[0]?.id ?? '')
  const [stageId, setStageId] = useState(initialStage?.id ?? '')

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
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
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
          <select id="status" name="status" className="input" defaultValue={deal?.status ?? 'open'}>
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </select>
        </div>

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

        <div>
          <label className="label" htmlFor="contact_id">
            Contact
          </label>
          <select
            id="contact_id"
            name="contact_id"
            className="input"
            defaultValue={deal?.contact_id ?? defaultContactId ?? ''}
          >
            <option value="">—</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="company_id">
            Company
          </label>
          <select id="company_id" name="company_id" className="input" defaultValue={deal?.company_id ?? ''}>
            <option value="">—</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
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
