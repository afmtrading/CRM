import { z } from 'zod'

import { CURRENCIES } from '@/lib/format'

/**
 * The invoice header, and the rule about what a save actually writes.
 *
 * The same shape as lib/sales-order-header, and here for the same reason: the
 * header stopped being one card. It is now spread across Invoice Detail and
 * Notes, each posting on its own, and every field in this schema parses to
 * null or '' when it is absent — so without the `has` walk below, saving the
 * notes would clear the payment terms and the due date.
 *
 * That defect shipped once already on the sales order, silently, for as long
 * as its header was split. This module exists so the invoice does not learn
 * it a second time, and it is in lib rather than beside the action because a
 * 'use server' file may only export async functions.
 */

const text = (max: number) => z.string().trim().max(max).default('')

export const headerSchema = z.object({
  /*
   * Present only on the Invoice Detail card, and only while the invoice is a
   * draft with no money on it — a sent document's date is what the customer
   * received. Optional so the other cards parse; min(1) when it is posted,
   * because an invoice has to have a date.
   */
  issue_date: z.string().trim().min(1).optional(),
  /* Blank is a real answer here: it means no due date rather than "unchanged". */
  due_date: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
  payment_terms: text(200),
  /*
   * Money off the whole document, as a pair — a kind and a rate, exactly like
   * a line's revision. The table's CHECK insists on both or neither, which is
   * why `headerPatch` normalises them together below rather than letting one
   * arrive without the other.
   */
  discount_type: z.enum(['percent', 'fixed']).optional().catch(undefined),
  discount_rate: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined
      if (value === '') return null
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
    }),
  notes: z.string().max(20_000).default(''),
  /* A checkbox, sent as a hidden-false-then-checkbox pair. */
  show_discount: z
    .string()
    .trim()
    .transform((value) => value === 'true' || value === 'on')
    .default('true'),
  /*
   * Optional, with no default. A sent or part-paid invoice shows its currency
   * rather than offering it, so the browser sends nothing — and a default here
   * would write that default over the real currency on every unrelated save.
   * The database refuses the change too; this is the interface agreeing.
   */
  currency: z.enum(CURRENCIES).optional().catch(undefined),
  /* Blank is "direct", which is a real answer and has to reach null. */
  marketplace_id: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
})

/**
 * The columns that mean "nothing" rather than "leave it alone" when blank.
 *
 * due_date and marketplace_id are absent from this set because their own
 * transforms already turn '' into null — putting them here would be a second
 * opinion that happens to agree.
 */
export const HEADER_NULLABLE = new Set(['payment_terms', 'notes'])

/**
 * What one card's save should change, and nothing else.
 *
 * `has` is the only honest test: HTML gives the server no way to tell a
 * cleared field from one that was never on the page, so the presence of the
 * key is the question being asked. Built by walking what parsed rather than by
 * naming the fields twice, so a field added to the schema and to a card is
 * carried without anybody remembering to add it here as well.
 */
export function headerPatch(
  parsed: z.infer<typeof headerSchema>,
  formData: Pick<FormData, 'has'>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(parsed)) {
    if (!formData.has(key)) continue
    // A currency the picker disabled arrives as nothing rather than as blank.
    if (key === 'currency' && !value) continue
    patch[key] = HEADER_NULLABLE.has(key) ? (value as string) || null : value
  }

  /*
   * The pair is whole or absent.
   *
   * A rate cleared takes its kind with it — otherwise a kind sits on the row
   * with nothing to apply, which the CHECK refuses and which would surface as
   * a database error on an ordinary save. A rate typed with no kind chosen is
   * a percent, which is what somebody typing a number into a discount box
   * means. Done here rather than only in the browser so the constraint cannot
   * be tripped by a form this file has not seen.
   */
  if ('discount_rate' in patch || 'discount_type' in patch) {
    const rate = patch.discount_rate as number | null | undefined
    if (rate === null || rate === undefined) {
      patch.discount_rate = null
      patch.discount_type = null
    } else {
      patch.discount_type = patch.discount_type || 'percent'
    }
  }

  return patch
}
