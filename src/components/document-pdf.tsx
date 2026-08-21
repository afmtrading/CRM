import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer'

import { formatDay, formatNumber, formatPrice } from '@/lib/format'
import { partyIsEmpty } from '@/lib/document'
import type { DocumentModel, DocumentParty } from '@/lib/document'

/**
 * The document as a real PDF.
 *
 * This reverses a stance the old printable component stated outright — "no PDF
 * library, the browser already has a very good one behind Ctrl+P". That was
 * right while the document was a web page somebody printed. It stopped being
 * right when the document had to carry a footer on every page and a truthful
 * "Page 1/3": browser print gives no reliable way to repeat a footer or count
 * pages, the result differs between Chrome and Safari, and every reader has to
 * be told which browser to use and which boxes to untick. A downloaded file is
 * a downloaded file.
 *
 * Helvetica is the built-in face, so nothing is fetched to render text and the
 * output is byte-identical wherever this runs.
 */

const BRAND = '#004a80'
const BRAND_LIGHT = '#f1f6fd'
const RULE = '#cbd5e1'
const MUTED = '#64748b'
const INK = '#0f172a'

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 56, // room for the fixed footer
    paddingHorizontal: 36,
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: INK,
  },

  // --- letterhead ---------------------------------------------------------
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  headLeft: { flexDirection: 'row', gap: 12, maxWidth: '58%' },
  logo: { width: 96, height: 60, objectFit: 'contain' },
  orgName: { fontFamily: 'Helvetica-Bold', fontSize: 12 },
  repLine: { fontSize: 9, marginTop: 2, color: INK },
  headRight: { alignItems: 'flex-start' },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 22, marginBottom: 4 },
  metaLine: { fontSize: 10, marginTop: 1 },
  rule: { borderBottomWidth: 3, borderBottomColor: INK, marginTop: 10, marginBottom: 14 },

  // --- the two boxes ------------------------------------------------------
  boxes: { flexDirection: 'row', gap: 10 },
  box: {
    flex: 1,
    borderWidth: 1,
    borderColor: RULE,
    borderRadius: 3,
    padding: 8,
    minHeight: 58,
  },
  boxLabel: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
    letterSpacing: 0.8,
    color: MUTED,
    marginBottom: 3,
  },
  boxLine: { fontSize: 9, marginTop: 1 },

  // --- items --------------------------------------------------------------
  table: { marginTop: 16 },
  th: {
    flexDirection: 'row',
    backgroundColor: BRAND,
    color: '#ffffff',
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  thText: { fontFamily: 'Helvetica-Bold', fontSize: 8 },
  tr: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  trAlt: { backgroundColor: '#f8fafc' },
  lineNote: { fontSize: 7.5, color: MUTED, marginTop: 1 },

  // --- money --------------------------------------------------------------
  totalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  totals: { width: '52%', backgroundColor: BRAND_LIGHT, padding: 8, borderRadius: 3 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  totalStrong: { fontFamily: 'Helvetica-Bold' },

  // --- sections -----------------------------------------------------------
  section: { marginTop: 16 },
  sectionLabel: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
    letterSpacing: 0.8,
    color: MUTED,
    marginBottom: 3,
  },
  body: { fontSize: 9, lineHeight: 1.4 },

  // --- footer -------------------------------------------------------------
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 36,
    right: 36,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: RULE,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 7.5,
    color: MUTED,
  },
})

/** Column widths, which depend on whether the discount is being shown. */
function columns(showDiscount: boolean) {
  return showDiscount
    ? { name: '30%', sku: '13%', unit: '9%', qty: '8%', price: '13%', rate: '12%', total: '15%' }
    : { name: '38%', sku: '15%', unit: '10%', qty: '9%', price: '13%', rate: '0%', total: '15%' }
}

function PartyBox({ label, party }: { label: string; party: DocumentParty | null }) {
  /*
   * An all-null party reads as absent rather than as a box somebody forgot to
   * fill in — which is what it looked like when the order had no company saved
   * against it and the document printed an empty rectangle.
   */
  const empty = partyIsEmpty(party)

  return (
    <View style={styles.box}>
      <Text style={styles.boxLabel}>{label}</Text>
      {party && !empty ? (
        <>
          {party.company ? (
            <Text style={[styles.boxLine, { fontFamily: 'Helvetica-Bold' }]}>{party.company}</Text>
          ) : null}
          {party.contact ? <Text style={styles.boxLine}>{party.contact}</Text> : null}
          {party.phone ? <Text style={styles.boxLine}>{party.phone}</Text> : null}
          {party.email ? <Text style={styles.boxLine}>{party.email}</Text> : null}
          {party.address ? <Text style={styles.boxLine}>{party.address}</Text> : null}
        </>
      ) : (
        <Text style={[styles.boxLine, { color: MUTED }]}>Not set</Text>
      )}
    </View>
  )
}

export function DocumentPdf({ model }: { model: DocumentModel }) {
  const col = columns(model.showDiscount)
  const money = (value: number) => formatPrice(value, model.currency)

  return (
    <Document title={`${model.kind} ${model.number}`}>
      <Page size="LETTER" style={styles.page}>
        {/* ------------------------------------------------------------- */}
        {/* Letterhead. Page one only: pages after this carry the number   */}
        {/* in the footer, which is what somebody reassembling a dropped   */}
        {/* stack actually needs.                                          */}
        <View style={styles.head}>
          <View style={styles.headLeft}>
            {model.organization.logo ? (
              /* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image takes no alt */
              <Image style={styles.logo} src={model.organization.logo} />
            ) : null}
            <View>
              <Text style={styles.orgName}>{model.organization.name}</Text>
              {model.rep ? (
                <>
                  <Text style={styles.repLine}>{model.rep.name}</Text>
                  {model.rep.phone ? <Text style={styles.repLine}>{model.rep.phone}</Text> : null}
                  {model.rep.email ? <Text style={styles.repLine}>{model.rep.email}</Text> : null}
                </>
              ) : null}
            </View>
          </View>

          <View style={styles.headRight}>
            <Text style={styles.title}>{model.kind}</Text>
            <Text style={styles.metaLine}>
              {model.kind === 'Invoice' ? 'Invoice #' : 'S.O. #'}: {model.number}
            </Text>
            <Text style={styles.metaLine}>Date: {formatDay(model.date)}</Text>
            {model.due ? <Text style={styles.metaLine}>Due: {formatDay(model.due)}</Text> : null}
            {model.customerId ? (
              <Text style={styles.metaLine}>Customer ID: {model.customerId}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.rule} />

        <View style={styles.boxes}>
          <PartyBox label="CUSTOMER" party={model.billTo} />
          {model.shipTo ? <PartyBox label="SHIP TO" party={model.shipTo} /> : null}
          <View style={styles.box}>
            <Text style={styles.boxLabel}>DETAILS</Text>
            {model.details.map((detail) => (
              <Text key={detail.label} style={styles.boxLine}>
                {detail.label}: {detail.value}
              </Text>
            ))}
          </View>
        </View>

        {/* ------------------------------------------------------------- */}
        {/* Items. The header repeats on every page it spills onto —       */}
        {/* `fixed` on a row inside a table is what react-pdf gives for    */}
        {/* that — so a second page of lines is still readable.            */}
        <View style={styles.table}>
          <View style={styles.th} fixed>
            <Text style={[styles.thText, { width: col.name }]}>Item</Text>
            <Text style={[styles.thText, { width: col.sku }]}>SKU</Text>
            <Text style={[styles.thText, { width: col.unit }]}>UoM</Text>
            <Text style={[styles.thText, { width: col.qty, textAlign: 'right' }]}>Qty</Text>
            <Text style={[styles.thText, { width: col.price, textAlign: 'right' }]}>Unit $</Text>
            {model.showDiscount ? (
              <Text style={[styles.thText, { width: col.rate, textAlign: 'right' }]}>Rate $</Text>
            ) : null}
            <Text style={[styles.thText, { width: col.total, textAlign: 'right' }]}>Total</Text>
          </View>

          {model.lines.map((line, index) => (
            <View
              key={`${line.name}-${index}`}
              style={index % 2 === 1 ? [styles.tr, styles.trAlt] : styles.tr}
              wrap={false}
            >
              <View style={{ width: col.name }}>
                <Text>{line.name}</Text>
              </View>
              <Text style={{ width: col.sku }}>{line.sku || '—'}</Text>
              <Text style={{ width: col.unit }}>{line.unit || '—'}</Text>
              <Text style={{ width: col.qty, textAlign: 'right' }}>
                {formatNumber(line.quantity)}
              </Text>
              <Text style={{ width: col.price, textAlign: 'right' }}>{money(line.unitPrice)}</Text>
              {model.showDiscount ? (
                <Text style={{ width: col.rate, textAlign: 'right' }}>{money(line.rate)}</Text>
              ) : null}
              <Text style={{ width: col.total, textAlign: 'right' }}>{money(line.lineTotal)}</Text>
            </View>
          ))}
        </View>

        {/* ------------------------------------------------------------- */}
        {/* Money. Sub-total and shipping only appear when carriage was    */}
        {/* actually charged — a "$0.00" shipping line invites the         */}
        {/* question it is trying to answer.                               */}
        <View style={styles.totalsWrap}>
          <View style={styles.totals}>
            {model.shipping !== 0 ? (
              <>
                <View style={styles.totalRow}>
                  <Text>Sub-total</Text>
                  <Text>{money(model.subtotal)}</Text>
                </View>
                <View style={styles.totalRow}>
                  <Text>Shipping</Text>
                  <Text>{money(model.shipping)}</Text>
                </View>
              </>
            ) : null}
            <View style={styles.totalRow}>
              <Text>Order total</Text>
              <Text>{money(model.total)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text>Total deposits</Text>
              <Text>{money(model.paid)}</Text>
            </View>
            <View style={[styles.totalRow, { marginTop: 4 }]}>
              <Text style={styles.totalStrong}>Balance due</Text>
              <Text style={styles.totalStrong}>{money(model.balance)}</Text>
            </View>
          </View>
        </View>

        {model.payments.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{model.paymentsTitle.toUpperCase()}</Text>
            <View style={[styles.tr, { borderBottomColor: RULE, paddingHorizontal: 0 }]}>
              <Text style={[styles.thText, { width: '20%', color: MUTED }]}>Date</Text>
              <Text style={[styles.thText, { width: '20%', color: MUTED }]}>Method</Text>
              <Text style={[styles.thText, { width: '40%', color: MUTED }]}>Note</Text>
              <Text style={[styles.thText, { width: '20%', color: MUTED, textAlign: 'right' }]}>
                Amount
              </Text>
            </View>
            {model.payments.map((payment, index) => (
              <View
                key={`${payment.paidAt}-${index}`}
                style={[styles.tr, { paddingHorizontal: 0 }]}
                wrap={false}
              >
                <Text style={{ width: '20%' }}>{formatDay(payment.paidAt)}</Text>
                <Text style={{ width: '20%' }}>{payment.method || '—'}</Text>
                <Text style={{ width: '40%' }}>{payment.note || '—'}</Text>
                <Text style={{ width: '20%', textAlign: 'right' }}>{money(payment.amount)}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {model.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>CUSTOMER NOTES</Text>
            <Text style={styles.body}>{model.notes}</Text>
          </View>
        ) : null}

        {model.terms ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>TERMS &amp; CONDITIONS</Text>
            <Text style={styles.body}>{model.terms}</Text>
          </View>
        ) : null}

        {/* ------------------------------------------------------------- */}
        {/* Every page, including ones this component never sees the       */}
        {/* contents of — `fixed` renders it per page and `render` is      */}
        {/* called with that page's own numbers.                           */}
        <View style={styles.footer} fixed>
          <Text>{model.organization.name}</Text>
          <Text>Strictly Confidential</Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber}/${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}

/** The finished bytes, ready to be handed to a browser. */
export async function renderDocumentPdf(model: DocumentModel): Promise<Buffer> {
  return renderToBuffer(<DocumentPdf model={model} />)
}
