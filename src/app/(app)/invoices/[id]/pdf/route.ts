import { NextResponse } from 'next/server'

import { requireSession, scoped } from '@/lib/tenancy'
import { documentTotals, ledgerBalance, round2 } from '@/lib/sales'
import { documentDetails, documentFilename } from '@/lib/document'
import type { DocumentModel } from '@/lib/document'
import { loadOrganizationLogo } from '@/lib/document-logo'
import { renderDocumentPdf } from '@/components/document-pdf'
import { contactName } from '@/lib/format'
import type {
  CompanyRow,
  ContactRow,
  InvoiceLineRow,
  InvoicePaymentRow,
  InvoiceRow,
  ProductRow,
  UserRow,
} from '@/lib/database.types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const context = await requireSession()

  const { data } = await scoped(context, 'invoices').select('*').eq('id', id).maybeSingle()
  if (!data) return new NextResponse('Not found', { status: 404 })
  const invoice = data as InvoiceRow

  const [{ data: lineRows }, { data: paymentRows }, { data: company }, { data: contact }, { data: owner }] =
    await Promise.all([
      scoped(context, 'invoice_lines').select('*').eq('invoice_id', id).order('position'),
      scoped(context, 'invoice_payments').select('*').eq('invoice_id', id).order('paid_at'),
      invoice.company_id
        ? scoped(context, 'companies').select('*').eq('id', invoice.company_id).maybeSingle()
        : Promise.resolve({ data: null }),
      invoice.contact_id
        ? scoped(context, 'contacts').select('*').eq('id', invoice.contact_id).maybeSingle()
        : Promise.resolve({ data: null }),
      invoice.owner_id
        ? scoped(context, 'users').select('*').eq('id', invoice.owner_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ])

  const lines = (lineRows ?? []) as InvoiceLineRow[]
  const payments = (paymentRows ?? []) as InvoicePaymentRow[]

  /*
   * Only for the unit of measure. Everything else on an invoice line is a
   * snapshot taken at conversion — a product renamed tomorrow does not rewrite
   * what this document said today — and invoice_lines has no unit column of
   * its own, which 20260263000000 wrote down as a known gap.
   */
  const productIds = lines.map((line) => line.product_id).filter(Boolean) as string[]
  const { data: productRows } = productIds.length
    ? await scoped(context, 'products').select('*').in('id', productIds)
    : { data: [] }
  const productById = new Map(((productRows ?? []) as ProductRow[]).map((p) => [p.id, p]))

  const paid = ledgerBalance(payments)
  const totals = documentTotals(lines, Number(invoice.shipping_charge), paid)

  const buyer = company as CompanyRow | null
  const person = contact as ContactRow | null
  const rep = owner as UserRow | null

  const model: DocumentModel = {
    kind: 'Invoice',
    number: invoice.number,
    date: invoice.issue_date,
    due: invoice.due_date,
    currency: invoice.currency,
    organization: {
      name: context.organization.name,
      logo: await loadOrganizationLogo(context.organization.logo_url),
    },
    /*
     * owner_name is the name as it read at issue, and it is the one that
     * belongs on a document. The row is still read for the phone and email,
     * which are how somebody reaches them today rather than in March.
     */
    rep: rep
      ? { name: invoice.owner_name || rep.name || rep.email, phone: rep.phone, email: rep.email }
      : invoice.owner_name
        ? { name: invoice.owner_name, phone: null, email: null }
        : null,
    customerId: buyer?.code ?? null,
    billTo: {
      company: buyer?.name ?? null,
      contact: person ? contactName(person) : null,
      phone: person?.phone ?? buyer?.phone ?? null,
      email: person?.email ?? null,
    },
    shipTo: null,
    details: documentDetails([
      { label: 'Representative', value: invoice.owner_name ?? (rep ? rep.name || rep.email : null) },
      { label: 'Payment Terms', value: invoice.payment_terms },
      { label: 'Currency', value: invoice.currency },
    ]),
    lines: lines.map((line) => {
      const product = line.product_id ? productById.get(line.product_id) : null
      const quantity = Number(line.quantity)
      return {
        name: line.name,
        sku: line.sku,
        unit: product?.unit || null,
        quantity,
        unitPrice: Number(line.unit_price),
        // What one actually came to. The order's revision is already baked into
        // the line's discount by the time it reaches an invoice.
        rate: quantity > 0 ? round2(Number(line.line_total) / quantity) : Number(line.unit_price),
        lineTotal: Number(line.line_total),
      }
    }),
    showDiscount: invoice.show_discount,
    subtotal: totals.subtotal,
    shipping: totals.shipping,
    total: totals.total,
    paid: totals.paid,
    balance: totals.balance,
    payments: payments.map((payment) => ({
      paidAt: payment.paid_at,
      method: payment.method,
      note: payment.note,
      amount: Number(payment.amount),
    })),
    paymentsTitle: 'Payments',
    notes: invoice.notes,
    terms: context.organization.document_terms,
  }

  const pdf = await renderDocumentPdf(model)
  const download = new URL(request.url).searchParams.get('download') === '1'

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${documentFilename(invoice.number)}"`,
      'cache-control': 'no-store',
    },
  })
}
