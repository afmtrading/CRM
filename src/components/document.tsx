import { formatDate, formatDay, formatNumber, formatPrice } from '@/lib/format'

/**
 * A sales order or an invoice, laid out to be printed.
 *
 * No PDF library. The browser already has a very good one behind Ctrl+P, and
 * this app has form: the charts are hand-rolled SVG rather than a charting
 * package, for the same reason — a dependency that renders a document is a lot
 * of weight to carry for something the platform does.
 *
 * The page chrome is hidden by `print:hidden` in the app layout, so what comes
 * out of the printer is this component and nothing else.
 */

export interface DocumentParty {
  name: string
  lines: string[]
}

export interface DocumentLine {
  name: string
  sku?: string | null
  notes?: string | null
  quantity: number
  unit: string | null
  unitPrice: number
  discount: number
  lineTotal: number
}

export interface DocumentPayment {
  paidAt: string
  method: string | null
  note: string | null
  amount: number
}

export function PrintableDocument({
  kind,
  number,
  status,
  currency,
  issued,
  due,
  organization,
  billTo,
  salesperson,
  paymentTerms,
  lines,
  subtotal,
  shipping,
  total,
  paid,
  payments,
  paymentsTitle,
  notes,
  terms,
}: {
  kind: string
  number: string
  status: string
  currency: string
  issued: string
  due?: string | null
  organization: string
  billTo: DocumentParty | null
  salesperson: string | null
  paymentTerms: string | null
  lines: DocumentLine[]
  subtotal: number
  shipping: number
  total: number
  paid: number
  payments: DocumentPayment[]
  paymentsTitle: string
  notes: string | null
  /**
   * Optional, because only one of the two documents has them now: an invoice
   * still carries its terms, and a purchase order stopped asking for them.
   */
  terms?: string | null
}) {
  const balance = total - paid

  return (
    <article className="mx-auto max-w-3xl bg-white p-8 text-slate-900 print:p-0">
      <header className="flex items-start justify-between gap-8 border-b border-slate-300 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{organization}</h1>
          <p className="mt-1 text-sm uppercase tracking-widest text-slate-500">{kind}</p>
        </div>
        <div className="text-right text-sm">
          <p className="text-lg font-semibold">{number}</p>
          <p className="text-slate-500">{status}</p>
          <p className="mt-2 text-slate-600">Issued {formatDay(issued)}</p>
          {due && <p className="text-slate-600">Due {formatDay(due)}</p>}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-8 border-b border-slate-200 py-6 text-sm">
        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Bill to
          </h2>
          {billTo ? (
            <>
              <p className="font-medium">{billTo.name}</p>
              {billTo.lines.map((line) => (
                <p key={line} className="text-slate-600">
                  {line}
                </p>
              ))}
            </>
          ) : (
            <p className="text-slate-400">Not set</p>
          )}
        </div>
        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Details
          </h2>
          {salesperson && <p className="text-slate-600">Salesperson: {salesperson}</p>}
          {paymentTerms && <p className="text-slate-600">Terms: {paymentTerms}</p>}
          <p className="text-slate-600">Currency: {currency}</p>
        </div>
      </section>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wider text-slate-500">
            <th className="pb-2">Item</th>
            <th className="pb-2 text-right">Qty</th>
            <th className="pb-2 text-right">Price</th>
            <th className="pb-2 text-right">Discount</th>
            <th className="pb-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index} className="border-b border-slate-100 align-top">
              <td className="py-2">
                <span className="font-medium">{line.name}</span>
                {line.sku && <span className="ml-2 text-xs text-slate-400">{line.sku}</span>}
                {line.notes && <span className="block text-xs text-slate-500">{line.notes}</span>}
              </td>
              <td className="py-2 text-right">
                {formatNumber(line.quantity)}
                {line.unit && <span className="ml-1 text-xs text-slate-400">{line.unit}</span>}
              </td>
              <td className="py-2 text-right">{formatPrice(line.unitPrice, currency)}</td>
              <td className="py-2 text-right">
                {line.discount > 0 ? formatPrice(line.discount, currency) : '—'}
              </td>
              <td className="py-2 text-right font-medium">
                {formatPrice(line.lineTotal, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="mt-6 flex justify-end">
        <dl className="w-64 space-y-1 text-sm">
          <Line label="Subtotal" value={formatPrice(subtotal, currency)} />
          <Line label="Shipping" value={formatPrice(shipping, currency)} />
          <Line label="Total" value={formatPrice(total, currency)} strong />
          {paid !== 0 && (
            <>
              <Line label={paymentsTitle} value={formatPrice(paid, currency)} />
              <Line label="Balance due" value={formatPrice(balance, currency)} strong />
            </>
          )}
        </dl>
      </section>

      {payments.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            {paymentsTitle}
          </h2>
          <table className="w-full text-sm">
            <tbody>
              {payments.map((payment, index) => (
                <tr key={index} className="border-b border-slate-100">
                  <td className="py-1.5">{formatDate(payment.paidAt)}</td>
                  <td className="py-1.5 text-slate-600">{payment.method ?? ''}</td>
                  <td className="py-1.5 text-slate-500">{payment.note ?? ''}</td>
                  <td className="py-1.5 text-right">{formatPrice(payment.amount, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {(notes || terms) && (
        <footer className="mt-8 space-y-3 border-t border-slate-200 pt-6 text-sm">
          {notes && (
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Notes</h2>
              <p className="whitespace-pre-wrap text-slate-700">{notes}</p>
            </div>
          )}
          {terms && (
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Terms</h2>
              <p className="whitespace-pre-wrap text-slate-600">{terms}</p>
            </div>
          )}
        </footer>
      )}
    </article>
  )
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`flex justify-between ${
        strong ? 'border-t border-slate-300 pt-1 font-semibold' : 'text-slate-600'
      }`}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
