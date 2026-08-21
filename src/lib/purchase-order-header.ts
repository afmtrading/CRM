import { z } from 'zod'

import { CURRENCIES } from '@/lib/format'

/**
 * The purchase order header, and the rule about what a save actually writes.
 *
 * In lib rather than beside the action because a 'use server' file may only
 * export async functions, and this is the piece that broke: `order_date` was
 * the one field the schema still insisted on, while only one of the five cards
 * that post to this header carries it. Saving the notes, the shipping or the
 * customer therefore parsed as a missing required string, came back
 * "Required", and wrote nothing — for four cards, silently, for as long as the
 * header was split up.
 *
 * Tested directly, so that cannot happen again the next time a field is added.
 */

/** Shared with the line schema in the action, so the two cannot drift. */
export const text = (max: number) => z.string().trim().max(max).default('')

export const optionalId = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .default(null)

export const headerSchema = z.object({
  company_id: optionalId,
  contact_id: optionalId,
  owner_id: optionalId,
  location_id: optionalId,
  /*
   * Optional, with no default. The picker is disabled once the order leaves
   * draft, so the browser sends nothing — and a default here would write that
   * default over the order's real currency on every unrelated save.
   */
  currency: z.enum(CURRENCIES).optional().catch(undefined),
  /* Blank is "direct", which is a real answer and has to reach null. */
  marketplace_id: optionalId,
  /* Where it goes, when that is not who is billed. */
  ship_to_company_id: optionalId,
  ship_to_contact_id: optionalId,
  shipping_address: z.string().max(2_000).default(''),
  shipping_method: text(120),
  shipping_responsibility: text(120),
  /* Also a checkbox pair. Whether the document shows what a line came down from. */
  show_discount: z
    .string()
    .trim()
    .transform((value) => value === 'true' || value === 'on')
    .default('true'),
  /*
   * `deposit_required` was here and is gone: the desk does not want the
   * checkbox. The column is untouched — nothing posts the key now, so the
   * `has` walk never writes it — and whatever an order already said is still
   * stored. Deposit information stays, and so do the deposits themselves,
   * which were always rows rather than a flag.
   */
  deposit_information: z.string().max(2_000).default(''),
  /*
   * Optional, like everything else on a header now spread across five cards.
   *
   * It was the one field that still had to be present, and only the Purchase
   * Order Detail card carries it — so saving the notes, the shipping, or the
   * customer parsed as a missing required string and came back "Required" with
   * nothing written. The value looked like it had been typed and thrown away,
   * because it had been. The `formData.has` walk below is what decides whether
   * a field is being answered; a schema that also insists is a second, quieter
   * opinion that disagrees.
   *
   * Still min(1) when the card that owns it does post it: a date cleared there
   * is somebody emptying the field, and an order has to have a date.
   */
  order_date: z.string().trim().min(1).optional(),
  payment_terms: text(200),
  shipping_charge: z.coerce.number().min(0).default(0),
  notes: z.string().max(20_000).default(''),
})

/**
 * The columns that mean "nothing" rather than "leave it alone" when blank.
 *
 * Everything else on the header is text, and text that arrives empty from a
 * form that asked for it is somebody clearing the field.
 */
export const HEADER_NULLABLE = new Set([
  'payment_terms',
  'notes',
  'shipping_address',
  'shipping_method',
  'shipping_responsibility',
  'deposit_information',
])


/**
 * What one card's save should change, and nothing else.
 *
 * A form that does not ask about a value must not answer for it. The header is
 * spread across several cards — who it is for, what it is, how it ships, what
 * it says — and each posts on its own. Every field parses to null or '' when
 * absent, so without this rule saving the notes would wipe the shipping
 * method. `has` is the only honest test: HTML gives the server no way to tell
 * a cleared field from one that was never on the page, so the presence of the
 * key is the question being asked.
 *
 * Built by walking what parsed rather than by naming the fields twice, so a
 * field added to the schema and to a card is carried without anybody
 * remembering to add it here as well.
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

  return patch
}
