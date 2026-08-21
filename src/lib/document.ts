/**
 * What a purchase order or an invoice says on paper.
 *
 * One shape, built by both documents, rendered by one component. The two have
 * drifted apart before — an invoice printed its terms for a week after the
 * order stopped — and the cheapest guard against that is that neither of them
 * owns a layout.
 *
 * Nothing in here reads the database. The pages fetch, this shapes, the
 * renderer draws: that is what lets the shaping be unit-tested without a
 * Postgres, and it is why the money arrives already computed by lib/sales
 * rather than being recomputed a third time down here.
 */

export interface DocumentParty {
  /** The business. Null on a document raised against a person with no company. */
  company: string | null
  contact: string | null
  phone: string | null
  email: string | null
  /** Free text, already line-broken. Only the ship-to carries one. */
  address?: string | null
}

export interface DocumentLine {
  name: string
  sku: string | null
  unit: string | null
  quantity: number
  /** List price for one, before any revision. */
  unitPrice: number
  /**
   * What one actually costs after the revision — the mock's "Rate $".
   *
   * Equal to unitPrice on a line nobody discounted, which is why the column
   * can be hidden without the reader losing anything: the total already has
   * the revision in it either way.
   */
  rate: number
  lineTotal: number
}

export interface DocumentPayment {
  paidAt: string
  method: string | null
  note: string | null
  amount: number
}

export interface DocumentDetail {
  label: string
  value: string
}

export interface DocumentModel {
  /** "Purchase Order" or "Invoice", as printed. */
  kind: string
  number: string
  date: string
  /** Only an invoice has one. */
  due: string | null
  currency: string

  organization: { name: string; logo: string | null }
  /**
   * Whoever the document is signed by — the order's representative rather than
   * whoever pressed download, so two people downloading the same order get the
   * same paper.
   */
  rep: { name: string; phone: string | null; email: string | null } | null

  /** The short handle for the company, from companies.code. */
  customerId: string | null
  billTo: DocumentParty | null
  /** Only when it differs from bill to — otherwise the reader learns nothing. */
  shipTo: DocumentParty | null

  details: DocumentDetail[]
  lines: DocumentLine[]
  showDiscount: boolean

  subtotal: number
  shipping: number
  total: number
  paid: number
  balance: number

  payments: DocumentPayment[]
  paymentsTitle: string

  notes: string | null
  terms: string | null
}

/**
 * The details box, with the blanks left out.
 *
 * A document that prints "Payment Terms:" against nothing has told the reader
 * that somebody forgot rather than that there are none, so an unanswered
 * question does not get a line.
 */
export function documentDetails(
  entries: { label: string; value: string | null | undefined }[],
): DocumentDetail[] {
  return entries
    .map((entry) => ({ label: entry.label, value: (entry.value ?? '').trim() }))
    .filter((entry) => entry.value !== '')
}

/**
 * Whether a party has anything on it at all.
 *
 * An object whose every field is null is not a party — it is the shape of one.
 * The renderer drew it as an empty bordered box, which reads as a document
 * that forgot to say who it is for rather than one nobody has told yet.
 */
export function partyIsEmpty(party: DocumentParty | null): boolean {
  if (!party) return true
  return ![party.company, party.contact, party.phone, party.email, party.address].some(
    (value) => (value ?? '').trim() !== '',
  )
}

/**
 * Whether the ship-to is worth printing.
 *
 * Same company and no address of its own means the goods go where the bill
 * goes, and a second box repeating the first is noise on a document somebody
 * has to read in a warehouse.
 */
export function shipToWorthPrinting(
  billTo: DocumentParty | null,
  shipTo: DocumentParty | null,
): DocumentParty | null {
  if (!shipTo) return null
  const hasAddress = (shipTo.address ?? '').trim() !== ''
  const sameCompany = (shipTo.company ?? '') === (billTo?.company ?? '')
  const sameContact = (shipTo.contact ?? '') === (billTo?.contact ?? '')
  if (!hasAddress && sameCompany && sameContact) return null
  return shipTo
}

/**
 * The file a download is saved as.
 *
 * The document's own number, which is what somebody looking for it later will
 * search their downloads folder for. Anything the filesystem might object to
 * becomes a dash rather than being dropped, so two numbers cannot reduce to
 * one filename.
 */
export function documentFilename(number: string): string {
  const safe = number.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safe || 'document'}.pdf`
}
