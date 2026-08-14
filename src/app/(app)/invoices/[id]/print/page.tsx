import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import { INVOICE_STATUS_LABELS } from '@/lib/sales'
import type {
  CompanyRow,
  ContactRow,
  InvoiceLineRow,
  InvoicePaymentRow,
  InvoiceRow,
} from '@/lib/database.types'
import { PrintableDocument } from '@/components/document'

export const dynamic = 'force-dynamic'

/**
 * The invoice as a document.
 *
 * Everything on it is read straight off the invoice rather than recomputed —
 * the totals were fixed when it was issued, and a printed copy that disagreed
 * with the record would be the worst possible bug in this feature.
 */
export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const context = await requireSession()

  const { data } = await scoped(context, 'invoices').select('*').eq('id', id).maybeSingle()
  if (!data) notFound()
  const invoice = data as InvoiceRow

  const [{ data: lineRows }, { data: paymentRows }, { data: company }, { data: contact }] =
    await Promise.all([
      scoped(context, 'invoice_lines').select('*').eq('invoice_id', id).order('position'),
      scoped(context, 'invoice_payments').select('*').eq('invoice_id', id).order('paid_at'),
      invoice.company_id
        ? scoped(context, 'companies').select('*').eq('id', invoice.company_id).maybeSingle()
        : Promise.resolve({ data: null }),
      invoice.contact_id
        ? scoped(context, 'contacts').select('*').eq('id', invoice.contact_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ])

  const lines = (lineRows ?? []) as InvoiceLineRow[]
  const payments = (paymentRows ?? []) as InvoicePaymentRow[]
  const person = contact as ContactRow | null

  const billTo = company
    ? {
        name: (company as CompanyRow).name,
        lines: [
          person ? [person.first_name, person.last_name].filter(Boolean).join(' ') : '',
          person?.email ?? '',
          (company as CompanyRow).phone ?? '',
        ].filter(Boolean),
      }
    : null

  return (
    <PrintableDocument
      kind="Invoice"
      number={invoice.number}
      status={INVOICE_STATUS_LABELS[invoice.status]}
      currency={invoice.currency}
      issued={invoice.issue_date}
      due={invoice.due_date}
      organization={context.organization.name}
      billTo={billTo}
      salesperson={invoice.owner_name}
      paymentTerms={invoice.payment_terms}
      lines={lines.map((line) => ({
        name: line.name,
        sku: line.sku,
        notes: line.notes,
        quantity: Number(line.quantity),
        unit: null,
        unitPrice: Number(line.unit_price),
        discount: Number(line.discount),
        lineTotal: Number(line.line_total),
      }))}
      subtotal={Number(invoice.subtotal)}
      shipping={Number(invoice.shipping_charge)}
      total={Number(invoice.total)}
      paid={Number(invoice.amount_paid)}
      payments={payments.map((payment) => ({
        paidAt: payment.paid_at,
        method: payment.method,
        note: payment.note,
        amount: Number(payment.amount),
      }))}
      paymentsTitle="Payments"
      notes={invoice.notes}
      terms={invoice.terms}
    />
  )
}
