import { NextResponse } from 'next/server'

import { requireSession, scoped } from '@/lib/tenancy'
import {
  documentRevisionLabel,
  documentTotals,
  ledgerBalance,
  lineName,
  revisedUnitPrice,
} from '@/lib/sales'
import { documentFilename, salesOrderDetails, shipToWorthPrinting } from '@/lib/document'
import type { DocumentModel } from '@/lib/document'
import { loadOrganizationLogo } from '@/lib/document-logo'
import { renderDocumentPdf } from '@/components/document-pdf'
import { contactName } from '@/lib/format'
import type {
  CompanyRow,
  ContactRow,
  ProductRow,
  SalesOrderLineRow,
  SalesOrderPaymentRow,
  SalesOrderRow,
  StockLocationRow,
  UserRow,
} from '@/lib/database.types'

/**
 * The sales order as a file.
 *
 * Node rather than edge: the renderer is a Node library, and this is the one
 * place in the app that needs to be.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const context = await requireSession()

  const { data } = await scoped(context, 'sales_orders')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (!data) return new NextResponse('Not found', { status: 404 })
  const order = data as SalesOrderRow

  const [
    { data: lineRows },
    { data: paymentRows },
    { data: company },
    { data: contact },
    { data: shipCompany },
    { data: shipContact },
    { data: owner },
    { data: location },
  ] = await Promise.all([
    scoped(context, 'sales_order_lines').select('*').eq('sales_order_id', id).order('position'),
    scoped(context, 'sales_order_payments').select('*').eq('sales_order_id', id).order('paid_at'),
    order.company_id
      ? scoped(context, 'companies').select('*').eq('id', order.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    order.contact_id
      ? scoped(context, 'contacts').select('*').eq('id', order.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    order.ship_to_company_id
      ? scoped(context, 'companies').select('*').eq('id', order.ship_to_company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    order.ship_to_contact_id
      ? scoped(context, 'contacts').select('*').eq('id', order.ship_to_contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    order.owner_id
      ? scoped(context, 'users').select('*').eq('id', order.owner_id).maybeSingle()
      : Promise.resolve({ data: null }),
    order.location_id
      ? scoped(context, 'stock_locations')
          .select('*')
          .eq('id', order.location_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const lines = (lineRows ?? []) as SalesOrderLineRow[]
  const payments = (paymentRows ?? []) as SalesOrderPaymentRow[]

  const productIds = lines.map((line) => line.product_id).filter(Boolean) as string[]
  const { data: productRows } = productIds.length
    ? await scoped(context, 'products').select('*').in('id', productIds)
    : { data: [] }
  const productById = new Map(((productRows ?? []) as ProductRow[]).map((p) => [p.id, p]))

  const deposits = ledgerBalance(payments)
  const totals = documentTotals(lines, Number(order.shipping_charge), deposits, {
    rateType: order.discount_type,
    rate: order.discount_rate === null ? null : Number(order.discount_rate),
  })

  const buyer = company as CompanyRow | null
  const person = contact as ContactRow | null
  const rep = owner as UserRow | null

  const billTo = {
    company: buyer?.name ?? null,
    contact: person ? contactName(person) : null,
    phone: person?.phone ?? buyer?.phone ?? null,
    email: person?.email ?? null,
  }

  const shipPerson = shipContact as ContactRow | null
  const shipTo = shipToWorthPrinting(billTo, {
    company: (shipCompany as CompanyRow | null)?.name ?? buyer?.name ?? null,
    contact: shipPerson ? contactName(shipPerson) : null,
    phone: shipPerson?.phone ?? null,
    email: shipPerson?.email ?? null,
    address: order.shipping_address,
  })

  const model: DocumentModel = {
    kind: 'Sales Order',
    number: order.number,
    date: order.order_date,
    due: null,
    currency: order.currency,
    organization: {
      name: context.organization.name,
      logo: await loadOrganizationLogo(context.organization.logo_url),
    },
    rep: rep ? { name: rep.name || rep.email, phone: rep.phone, email: rep.email } : null,
    customerId: buyer?.code ?? null,
    billTo,
    shipTo,
    details: salesOrderDetails({
      location: (location as StockLocationRow | null)?.name,
      representative: rep ? rep.name || rep.email : null,
      paymentTerms: order.payment_terms,
      currency: order.currency,
      shipping: order.shipping_responsibility,
      shippingMethod: order.shipping_method,
    }),
    lines: lines.map((line) => {
      const product = line.product_id ? productById.get(line.product_id) : null
      return {
        name: lineName(line, product?.name),
        sku: product?.sku ?? null,
        // The line's own unit, falling back to the catalogue's — which is what
        // 20260263000000 added the column for.
        unit: line.unit || product?.unit || null,
        quantity: Number(line.quantity),
        unitPrice: Number(line.unit_price),
        rate: revisedUnitPrice(
          Number(line.unit_price),
          line.revised_rate_type,
          line.revised_rate === null ? null : Number(line.revised_rate),
        ),
        lineTotal: Number(line.line_total),
      }
    }),
    showDiscount: order.show_discount,
    // Deposits covering the order in full. Zero out of zero is not paid.
    paidInFull: totals.total > 0 && totals.balance <= 0,
    subtotal: totals.subtotal,
    discount: totals.discount,
    discountLabel: documentRevisionLabel(
      order.discount_type,
      order.discount_rate === null ? null : Number(order.discount_rate),
      order.currency,
    ),
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
    paymentsTitle: 'Deposits',
    notes: order.notes,
    terms: context.organization.document_terms,
  }

  const pdf = await renderDocumentPdf(model)
  const filename = documentFilename(order.number)

  /*
   * `inline` opens it in the browser's viewer, `attachment` saves it. The
   * button on the record asks for the download; opening the same URL in a tab
   * previews it, which is what somebody checking a document before sending it
   * wants.
   */
  const download = new URL(request.url).searchParams.get('download') === '1'

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      // A document is a statement about a moment; a cached copy of it is a
      // statement about a different one.
      'cache-control': 'no-store',
    },
  })
}
