import { describe, expect, it } from 'vitest'

import { renderDocumentPdf } from '@/components/document-pdf'
import type { DocumentModel } from '@/lib/document'

/**
 * That the document renders at all.
 *
 * A layout is not the kind of thing a unit test has opinions about, but "the
 * download produces a PDF" is, and it is the failure that would reach somebody
 * as a broken button rather than as a wonky margin. The renderer is a real
 * dependency doing real work here — no mock — so a version of it that stops
 * understanding one of these props fails the build rather than production.
 */

function model(overrides: Partial<DocumentModel> = {}): DocumentModel {
  return {
    kind: 'Sales Order',
    number: 'PO-Acme-0001',
    date: '2026-05-15',
    due: null,
    currency: 'USD',
    organization: { name: 'AFM Global Tradings', logo: null },
    rep: { name: 'Ruben', phone: '615-335-5582', email: 'ruben@afm.test' },
    customerId: 'ACME',
    billTo: {
      company: 'Acme LLC',
      contact: 'Paulina',
      phone: '615-335-5582',
      email: 'paulina@acme.test',
    },
    shipTo: null,
    details: [
      { label: 'Location', value: 'Columbia' },
      { label: 'Payment Terms', value: 'COD' },
    ],
    lines: [
      {
        name: 'Soap',
        sku: null,
        unit: 'Unit',
        quantity: 22,
        unitPrice: 5,
        rate: 5,
        lineTotal: 110,
      },
      {
        name: 'Waste baskets',
        sku: 'WB-1',
        unit: 'Case',
        quantity: 2,
        unitPrice: 12,
        rate: 12,
        lineTotal: 24,
      },
    ],
    showDiscount: true,
    subtotal: 134,
    shipping: 0,
    total: 134,
    paid: 0,
    balance: 134,
    payments: [],
    paymentsTitle: 'Deposits',
    notes: null,
    terms: null,
    ...overrides,
  }
}

/** The four bytes every PDF starts with. */
function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).toString('latin1') === '%PDF'
}

describe('renderDocumentPdf', () => {
  it('renders a sales order', async () => {
    const pdf = await renderDocumentPdf(model())
    expect(isPdf(pdf)).toBe(true)
    expect(pdf.byteLength).toBeGreaterThan(1000)
  }, 30_000)

  it('renders with the discount column hidden', async () => {
    const shown = await renderDocumentPdf(model({ showDiscount: true }))
    const hidden = await renderDocumentPdf(model({ showDiscount: false }))
    expect(isPdf(hidden)).toBe(true)
    // Fewer cells drawn, so fewer bytes. If these ever match, the flag stopped
    // reaching the renderer.
    expect(hidden.byteLength).not.toBe(shown.byteLength)
  }, 30_000)

  it('renders an invoice, with everything optional filled in', async () => {
    const pdf = await renderDocumentPdf(
      model({
        kind: 'Invoice',
        number: 'INV-0001',
        due: '2026-06-15',
        paymentsTitle: 'Payments',
        shipping: 45,
        total: 179,
        paid: 100,
        balance: 79,
        shipTo: {
          company: 'Columbia Warehousing',
          contact: 'Dock office',
          phone: null,
          email: null,
          address: '12 Dock Road',
        },
        payments: [
          { paidAt: '2026-05-31', method: 'Cash', note: 'Deposit #1', amount: 100 },
        ],
        notes: 'Commercial printers are cancelled (2)',
        terms: 'All sales are final. No exchanges or refunds.',
      }),
    )
    expect(isPdf(pdf)).toBe(true)
  }, 30_000)

  it('renders a document with nothing on it', async () => {
    const pdf = await renderDocumentPdf(
      model({ rep: null, billTo: null, customerId: null, details: [], lines: [] }),
    )
    expect(isPdf(pdf)).toBe(true)
  }, 30_000)

  it('spills onto more than one page without falling over', async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      name: `Item ${index + 1}`,
      sku: `SKU-${index + 1}`,
      unit: 'Unit',
      quantity: index + 1,
      unitPrice: 10,
      rate: 9,
      lineTotal: (index + 1) * 9,
    }))
    const pdf = await renderDocumentPdf(model({ lines: many }))
    expect(isPdf(pdf)).toBe(true)
    // "/Type /Page" appears once per page; a single-page result would mean the
    // table is being clipped rather than flowing.
    const pages = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0
    expect(pages).toBeGreaterThan(1)
  }, 60_000)
})
