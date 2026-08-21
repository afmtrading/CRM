import { notFound } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import { SALES_ORDER_STATUS_LABELS, documentTotals, ledgerBalance, lineName } from '@/lib/sales'
import type {
  CompanyRow,
  ContactRow,
  ProductRow,
  SalesOrderLineRow,
  SalesOrderPaymentRow,
  SalesOrderRow,
  UserRow,
} from '@/lib/database.types'
import { PrintableDocument } from '@/components/document'

export const dynamic = 'force-dynamic'

/** The order as a document: what gets printed, emailed or signed. */
export default async function SalesOrderPrintPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const context = await requireSession()

  const { data } = await scoped(context, 'sales_orders')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (!data) notFound()
  const order = data as SalesOrderRow

  const [{ data: lineRows }, { data: paymentRows }, { data: company }, { data: contact }, { data: owner }] =
    await Promise.all([
      scoped(context, 'sales_order_lines').select('*').eq('sales_order_id', id).order('position'),
      scoped(context, 'sales_order_payments').select('*').eq('sales_order_id', id).order('paid_at'),
      order.company_id
        ? scoped(context, 'companies').select('*').eq('id', order.company_id).maybeSingle()
        : Promise.resolve({ data: null }),
      order.contact_id
        ? scoped(context, 'contacts').select('*').eq('id', order.contact_id).maybeSingle()
        : Promise.resolve({ data: null }),
      order.owner_id
        ? scoped(context, 'users').select('*').eq('id', order.owner_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ])

  const lines = (lineRows ?? []) as SalesOrderLineRow[]
  const payments = (paymentRows ?? []) as SalesOrderPaymentRow[]

  // Names for the lines that reference the catalogue.
  const productIds = lines.map((line) => line.product_id).filter(Boolean) as string[]
  const { data: productRows } = productIds.length
    ? await scoped(context, 'products').select('*').in('id', productIds)
    : { data: [] }
  const productById = new Map(((productRows ?? []) as ProductRow[]).map((p) => [p.id, p]))

  const deposits = ledgerBalance(payments)
  const totals = documentTotals(lines, Number(order.shipping_charge), deposits)

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
      kind="Purchase order"
      number={order.number}
      status={SALES_ORDER_STATUS_LABELS[order.status]}
      currency={order.currency}
      issued={order.order_date}
      organization={context.organization.name}
      billTo={billTo}
      salesperson={owner ? (owner as UserRow).name || (owner as UserRow).email : null}
      paymentTerms={order.payment_terms}
      lines={lines.map((line) => {
        const product = line.product_id ? productById.get(line.product_id) : null
        return {
          name: lineName(line, product?.name),
          sku: product?.sku ?? null,
          notes: line.notes,
          quantity: Number(line.quantity),
          unit: product?.unit || null,
          unitPrice: Number(line.unit_price),
          discount: Number(line.discount),
          lineTotal: Number(line.line_total),
        }
      })}
      subtotal={totals.subtotal}
      shipping={totals.shipping}
      total={totals.total}
      paid={totals.paid}
      payments={payments.map((payment) => ({
        paidAt: payment.paid_at,
        method: payment.method,
        note: payment.note,
        amount: Number(payment.amount),
      }))}
      paymentsTitle="Deposits"
      notes={order.notes}
      /* No terms on a purchase order any more. The Document still takes them —
         an invoice has its own, and still prints them. */
    />
  )
}
