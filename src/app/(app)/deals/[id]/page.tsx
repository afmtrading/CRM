import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireSession, scoped, firstRow } from '@/lib/tenancy'
import { contactName, formatCurrency, formatDay, formatNumber, formatPercent } from '@/lib/format'
import { OPTION_COLOR_CLASSES, renderMarkdown } from '@/lib/field-options'
import { definitionsOnCard, displayValue, hasAnyValue } from '@/lib/custom-fields'
import type {
  ActivityRow,
  CustomFieldDefinitionRow,
  DealProductRow,
  DealRow,
  FieldOptionRow,
  ProductRow,
  StageRow,
  UserRow,
} from '@/lib/database.types'
import { ActivityComposer, ActivityTimeline } from '@/components/activity-timeline'
import { DateTime } from '@/components/date-time'
import { Empty, Field, FieldRow } from '@/components/contact-cards'
import { DealStatusBadge, PageHeader, Section } from '@/components/ui'
import { TrashIcon } from '@/components/icons'

import {
  addDealProduct,
  deleteDeal,
  removeDealProduct,
  resetDealProbability,
  updateDealProduct,
  useLineItemsForValue,
} from '../actions'
import { AddLineItem } from '../line-items'

type DealWithRelations = DealRow & {
  stages: (StageRow & { pipelines: { id: string; name: string } | null }) | null
  contacts: { id: string; first_name: string; last_name: string; email: string | null } | null
  companies: { id: string; name: string } | null
}

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const deal = await firstRow<DealWithRelations>(
    scoped(context, 'deals')
      .select(
        '*, stages(*, pipelines(id, name)), contacts(id, first_name, last_name, email), companies(id, name)',
      )
      .eq('id', id)
      .maybeSingle(),
  )

  if (!deal) notFound()

  const [
    { data: activities },
    { data: users },
    { data: lines },
    { data: catalogue },
    { data: definitions },
    { data: optionRows },
  ] = await Promise.all([
      scoped(context, 'activities')
        .select('*')
        .eq('related_to_type', 'deal')
        .eq('related_to_id', id)
        .order('occurred_at', { ascending: false })
        .limit(100),
      scoped(context, 'users').select('*').eq('status', 'active').order('name'),
      scoped(context, 'deal_products')
        .select('*, products(id, name, sku, unit)')
        .eq('deal_id', id)
        .order('position'),
      scoped(context, 'products')
        .select('*')
        .is('deleted_at', null)
        .eq('active', true)
        .order('name'),
      scoped(context, 'custom_field_definitions').select('*').order('order'),
      scoped(context, 'field_options').select('*').order('order'),
    ])

  const userList = (users ?? []) as UserRow[]
  const owner = userList.find((user) => user.id === deal.owner_id)
  const userName = (userId: string | null) => {
    if (!userId) return null
    const user = userList.find((candidate) => candidate.id === userId)
    return user ? user.name || user.email : null
  }
  const closedOwner = userList.find((user) => user.id === deal.closed_owner_id)

  const lineItems = (lines ?? []) as (DealProductRow & {
    products: { id: string; name: string; sku: string | null; unit: string } | null
  })[]
  const products = (catalogue ?? []) as ProductRow[]

  const lineTotal = lineItems.reduce((sum, line) => sum + Number(line.line_total), 0)
  const lineCost = lineItems.reduce((sum, line) => sum + Number(line.line_cost), 0)
  // The deal follows its line items unless someone typed a value. When the two
  // disagree, say so rather than quietly showing one of them.
  const followsProducts = deal.value_source === 'products'
  const valueDiffers =
    !followsProducts && lineItems.length > 0 && Math.abs(lineTotal - Number(deal.value)) > 0.005

  const notesHtml = renderMarkdown(deal.notes)

  // Organization-defined fields, split across the two cards a deal offers.
  const allDefinitions = (definitions ?? []) as CustomFieldDefinitionRow[]
  const options = (optionRows ?? []) as FieldOptionRow[]
  const customValues = (deal.custom_fields ?? {}) as Record<string, unknown>
  const detailFields = definitionsOnCard(allDefinitions, 'deal', 'details')
  const additionalFields = definitionsOnCard(allDefinitions, 'deal', 'additional')

  return (
    <>
      <PageHeader
        title={deal.name}
        description={`${formatCurrency(deal.value, deal.currency)} · ${deal.stages?.name ?? 'No stage'}`}
        actions={
          <>
            {/*
              Beside the name rather than buried in the Details card. Who owns
              a deal is the first thing somebody checks before acting on one,
              and the name is louder than its label because the name is the
              answer — the label is only there to say what the answer is to.
            */}
            <div className="mr-2 min-w-0 text-right">
              <p className="text-xs text-slate-500">Owner</p>
              <p className="truncate text-base font-semibold text-slate-900">
                {owner ? owner.name || owner.email : '—'}
              </p>
            </div>
            <Link href={`/deals/${id}/edit`} className="btn-secondary">
              Edit
            </Link>
            <form action={deleteDeal}>
              <input type="hidden" name="id" value={id} />
              <button
                type="submit"
                className="btn-danger"
                title="The deal moves to the recycle bin — an administrator can restore it"
              >
                Delete
              </button>
            </form>
          </>
        }
      />

      {/*
        Only an administrator can reach this, since the policy hides a deleted
        deal from everybody else. Saying so beats letting them edit a record
        that no one else can see and wondering later why it never appeared.
      */}
      {deal.deleted_at && (
        <p className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This deal is in the recycle bin. Nobody else can see it, and it counts towards nothing —
          not committed stock, not the pipeline.{' '}
          <Link href="/settings/deleted" className="font-medium underline">
            Restore it
          </Link>
          .
        </p>
      )}

      {/*
        Ordered for a narrow screen: the deal itself, then its lines, then what
        has been said about it. `contents` lets both groups' cards take part in
        one flex order on mobile; from lg the wrappers come back as columns.
        items-start is what stops the Details column stretching to the height of
        the one beside it.
      */}
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-3 lg:items-start">
        <div className="contents lg:block lg:space-y-5 lg:col-span-2">
          <Section
            className="order-2"
            title="Line items"
            actions={
              <span className="text-xs text-slate-500">
                {followsProducts
                  ? 'The deal value follows these lines'
                  : 'The deal value was entered by hand'}
              </span>
            }
          >
            {lineItems.length === 0 ? (
              <p className="mb-4 text-sm text-slate-500">
                Nothing listed yet. Adding a product sets the deal&rsquo;s value from its lines
                &mdash; unless a value has already been typed, which stays as it is.
              </p>
            ) : (
              <ul className="mb-4 divide-y divide-slate-100">
                {lineItems.map((line) => (
                  <li key={line.id} className="py-3 first:pt-0">
                    <form
                      action={updateDealProduct}
                      className="flex flex-wrap items-end gap-3 sm:flex-nowrap"
                    >
                      <input type="hidden" name="id" value={line.id} />
                      <input type="hidden" name="deal_id" value={id} />

                      <div className="min-w-40 flex-1">
                        {line.products ? (
                          <Link
                            href={`/products/${line.products.id}`}
                            className="text-sm font-medium text-slate-900 hover:text-brand-700"
                          >
                            {line.products.name}
                          </Link>
                        ) : (
                          <span className="text-sm text-slate-500">Unknown product</span>
                        )}
                        <p className="text-xs text-slate-400">
                          {[line.products?.sku, line.products?.unit && `per ${line.products.unit}`]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </p>
                      </div>

                      <div className="w-24">
                        <label className="label" htmlFor={`qty-${line.id}`}>
                          Qty
                        </label>
                        <input
                          id={`qty-${line.id}`}
                          name="quantity"
                          type="number"
                          step="0.001"
                          min="0"
                          className="input"
                          defaultValue={line.quantity}
                          readOnly={!context.canWrite}
                        />
                      </div>

                      <div className="w-28">
                        <label className="label" htmlFor={`price-${line.id}`}>
                          Price
                        </label>
                        <input
                          id={`price-${line.id}`}
                          name="unit_price"
                          type="number"
                          step="0.01"
                          min="0"
                          className="input"
                          defaultValue={line.unit_price}
                          readOnly={!context.canWrite}
                        />
                      </div>

                      <div className="w-20">
                        <label className="label" htmlFor={`disc-${line.id}`}>
                          Disc %
                        </label>
                        <input
                          id={`disc-${line.id}`}
                          name="discount_pct"
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          className="input"
                          defaultValue={line.discount_pct}
                          readOnly={!context.canWrite}
                        />
                      </div>

                      <div className="w-28 pb-2 text-right">
                        <p className="text-sm font-semibold text-slate-900">
                          {formatCurrency(Number(line.line_total), deal.currency)}
                        </p>
                        <p className="text-xs text-slate-400">
                          cost {formatCurrency(Number(line.line_cost), deal.currency)}
                        </p>
                      </div>

                      {context.canWrite && (
                        <div className="flex items-center gap-1 pb-1.5">
                          <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
                            Save
                          </button>
                          {/* Same form, different action — the row carries the
                              id and deal_id both of them need. */}
                          <button
                            type="submit"
                            formAction={removeDealProduct}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                            aria-label={`Remove ${line.products?.name ?? 'line item'}`}
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </form>
                  </li>
                ))}
              </ul>
            )}

            {lineItems.length > 0 && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3">
                <div className="text-sm text-slate-600">
                  <span className="font-semibold text-slate-900">
                    {formatCurrency(lineTotal, deal.currency)}
                  </span>{' '}
                  across {formatNumber(lineItems.length)} line
                  {lineItems.length === 1 ? '' : 's'}
                  <span className="mx-2 text-slate-300">·</span>
                  margin {formatCurrency(lineTotal - lineCost, deal.currency)}
                </div>

                {valueDiffers && (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-amber-800">
                    <span>
                      The deal is priced at {formatCurrency(Number(deal.value), deal.currency)}.
                    </span>
                    {context.canWrite && (
                      <form action={useLineItemsForValue}>
                        <input type="hidden" name="deal_id" value={id} />
                        <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
                          Use the line items
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            )}

            {context.canWrite && (
              <div className="border-t border-slate-100 pt-4">
                <AddLineItem
                  dealId={id}
                  dealCurrency={deal.currency}
                  products={products}
                  action={addDealProduct}
                />
              </div>
            )}
          </Section>

          <Section title="Notes" className="order-3">
            {notesHtml ? (
              <div
                className="space-y-2 text-sm leading-relaxed text-slate-700"
                // Safe by construction: renderMarkdown escapes the stored text
                // before applying formatting, so the only markup here is what it
                // generated. Covered by tests/field-options.test.ts.
                dangerouslySetInnerHTML={{ __html: notesHtml }}
              />
            ) : (
              <p className="text-sm text-slate-400">
                Nothing written down yet.{' '}
                <Link href={`/deals/${id}/edit`} className="text-brand-700 hover:underline">
                  Add a note
                </Link>
                .
              </p>
            )}
          </Section>

          <Section title="Activity" className="order-4">
            <ActivityComposer
              relatedToType="deal"
              relatedToId={id}
              users={userList}
              currentUserId={context.user.id}
            />
            <div className="mt-4 border-t border-slate-100 pt-2">
              <ActivityTimeline
                activities={(activities ?? []) as ActivityRow[]}
                users={userList}
                returnTo={`/deals/${id}`}
              />
            </div>
          </Section>
        </div>

        <div className="contents lg:block lg:space-y-5">
          {/*
            Status sits beside the card's own title rather than as the first
            row inside it: it is what the card is about, not one of the facts
            on it, and it is the thing somebody looks for first.
          */}
          <Section
            title="Details"
            className="order-1"
            actions={<DealStatusBadge status={deal.status} />}
          >
            {/*
              Ordered the way somebody reads a deal: who it is with, then what
              it is worth, then where it is, then when it lands. Separated by
              rules, because a column of label/value pairs with nothing between
              them makes the value under one label look like it belongs to the
              next.
            */}
            <dl className="divide-y divide-slate-100 text-sm">
              <FieldRow columns={1}>
                <Field label="Company">
                  {deal.companies ? (
                    <Link
                      href={`/companies/${deal.companies.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {deal.companies.name}
                    </Link>
                  ) : (
                    <Empty />
                  )}
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Contact">
                  {deal.contacts ? (
                    <Link
                      href={`/contacts/${deal.contacts.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {contactName(deal.contacts)}
                    </Link>
                  ) : (
                    <Empty />
                  )}
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Value">
                  <span className="flex flex-wrap items-center gap-2">
                    {formatCurrency(deal.value, deal.currency)}
                    {followsProducts ? (
                      <span className="badge bg-slate-100 text-slate-600">from line items</span>
                    ) : (
                      <span className="badge bg-amber-100 text-amber-800">entered by hand</span>
                    )}
                  </span>
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Weighted value">
                  {formatCurrency(deal.value * deal.probability, deal.currency)}
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Probability">
                  <span className="flex flex-wrap items-center gap-2">
                    {formatPercent(deal.probability)}
                    {deal.probability_overridden ? (
                      <>
                        <span className="badge bg-amber-100 text-amber-800">manual</span>
                        <form action={resetDealProbability}>
                          <input type="hidden" name="id" value={id} />
                          <button type="submit" className="text-xs text-brand-700 hover:underline">
                            Follow stage default
                          </button>
                        </form>
                      </>
                    ) : (
                      <span className="badge bg-slate-100 text-slate-600">stage default</span>
                    )}
                  </span>
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Pipeline / stage">
                  {deal.stages?.pipelines?.name ?? '—'} · {deal.stages?.name ?? '—'}
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Expected close">{formatDay(deal.expected_close_date)}</Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Actual close">{formatDay(deal.actual_close_date)}</Field>
              </FieldRow>
              {/*
                Only once the deal has closed, and only when it says something
                the Owner beside the deal name does not. Reporting reads
                closed_owner_id, so the day the two disagree — an account handed
                over after the win — is the day it matters that both are shown.
              */}
              {deal.closed_owner_id && deal.closed_owner_id !== deal.owner_id && (
                <FieldRow columns={1}>
                  <Field label="Closed by owner">
                    {closedOwner ? closedOwner.name || closedOwner.email : 'Someone since removed'}
                    <span className="mt-0.5 block text-xs text-slate-400">
                      Who this counts for in reporting. The account has changed hands since.
                    </span>
                  </Field>
                </FieldRow>
              )}
              {/* Whatever an admin put on this card, after the built-in rows. */}
              {detailFields.map((field) => {
                const shown = displayValue(customValues[field.key])
                if (!shown) return null
                return (
                  <FieldRow key={field.id} columns={1}>
                    <Field label={field.label}>
                      <CustomValue field={field} value={customValues[field.key]} options={options} />
                    </Field>
                  </FieldRow>
                )
              })}
              {deal.status === 'lost' && (
                <FieldRow columns={1}>
                  <Field label="Why it was lost">
                    {deal.loss_reason ?? (
                      <Link href={`/deals/${id}/edit`} className="text-brand-700 hover:underline">
                        Not recorded — say why
                      </Link>
                    )}
                  </Field>
                </FieldRow>
              )}
            </dl>
          </Section>

          {/* Last on a narrow screen: it is the card you go looking for. */}
          <Section title="Record history" className="order-5">
            <dl className="divide-y divide-slate-100 text-sm">
              <FieldRow columns={1}>
                <Field label="Created by">
                  <span className="block">{userName(deal.created_by) ?? 'Unknown'}</span>
                  <span className="text-xs text-slate-500">
                    <DateTime value={deal.created_at} />
                  </span>
                </Field>
              </FieldRow>
              <FieldRow columns={1}>
                <Field label="Updated by">
                  <span className="block">{userName(deal.updated_by) ?? 'Unknown'}</span>
                  <span className="text-xs text-slate-500">
                    <DateTime value={deal.updated_at} />
                  </span>
                </Field>
              </FieldRow>
            </dl>
          </Section>
        </div>
      </div>

      {/*
        Drawn only when the organization has defined fields for it and this deal
        has something in them — an empty card on every deal is furniture.
      */}
      {additionalFields.length > 0 && hasAnyValue(additionalFields, customValues) && (
        <div className="mt-5">
          <Section title="Additional info">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {additionalFields.map((field) => {
                const shown = displayValue(customValues[field.key])
                if (!shown) return null
                return (
                  <div key={field.id}>
                    <dt className="text-xs text-slate-500">{field.label}</dt>
                    <dd className="mt-0.5">
                      <CustomValue field={field} value={customValues[field.key]} options={options} />
                    </dd>
                  </div>
                )
              })}
            </dl>
          </Section>
        </div>
      )}
    </>
  )
}

/**
 * One organization-defined value.
 *
 * A select or multi-select renders as the coloured chips its options carry, so
 * a custom field looks like the built-in ones rather than like a second, plainer
 * mechanism bolted on beside them. Anything else is text.
 */
function CustomValue({
  field,
  value,
  options,
}: {
  field: CustomFieldDefinitionRow
  value: unknown
  options: FieldOptionRow[]
}) {
  const shown = displayValue(value)
  if (!shown) return <span className="text-slate-400">—</span>

  if (field.field_type === 'select' || field.field_type === 'multiselect') {
    const values = Array.isArray(value) ? value.map(String) : [String(value)]
    return (
      <span className="flex flex-wrap gap-1">
        {values.map((entry) => {
          const option = options.find(
            (candidate) =>
              candidate.entity_type === field.entity_type &&
              candidate.field_key === field.key &&
              candidate.value === entry,
          )
          return (
            <span
              key={entry}
              className={`badge ${option ? OPTION_COLOR_CLASSES[option.color] : 'bg-slate-100 text-slate-700'}`}
            >
              {entry}
            </span>
          )
        })}
      </span>
    )
  }

  return <span className="text-slate-800">{shown}</span>
}
