import { describe, expect, it } from 'vitest'

import {
  documentDetails,
  documentFilename,
  partyIsEmpty,
  salesOrderDetails,
  shipToWorthPrinting,
} from '@/lib/document'
import type { DocumentParty } from '@/lib/document'

describe('documentDetails', () => {
  it('drops the questions nobody answered', () => {
    expect(
      documentDetails([
        { label: 'Location', value: 'Columbia' },
        { label: 'Payment Terms', value: null },
        { label: 'Currency', value: 'USD' },
      ]),
    ).toEqual([
      { label: 'Location', value: 'Columbia' },
      { label: 'Currency', value: 'USD' },
    ])
  })

  it('treats whitespace as unanswered', () => {
    expect(documentDetails([{ label: 'Payment Terms', value: '   ' }])).toEqual([])
  })

  it('trims what it keeps', () => {
    expect(documentDetails([{ label: 'Payment Terms', value: ' COD ' }])).toEqual([
      { label: 'Payment Terms', value: 'COD' },
    ])
  })
})

describe('shipToWorthPrinting', () => {
  const billTo: DocumentParty = {
    company: 'Acme LLC',
    contact: 'Paulina',
    phone: '615-335-5582',
    email: 'paulina@acme.test',
  }

  it('says nothing when the goods go where the bill goes', () => {
    expect(
      shipToWorthPrinting(billTo, {
        company: 'Acme LLC',
        contact: 'Paulina',
        phone: null,
        email: null,
        address: null,
      }),
    ).toBeNull()
  })

  it('prints once there is an address of its own', () => {
    const shipTo = {
      company: 'Acme LLC',
      contact: 'Paulina',
      phone: null,
      email: null,
      address: '12 Dock Road',
    }
    expect(shipToWorthPrinting(billTo, shipTo)).toBe(shipTo)
  })

  it('prints when a different business receives', () => {
    const shipTo = {
      company: 'Columbia Warehousing',
      contact: null,
      phone: null,
      email: null,
      address: null,
    }
    expect(shipToWorthPrinting(billTo, shipTo)).toBe(shipTo)
  })

  it('prints when a different person receives at the same business', () => {
    const shipTo = {
      company: 'Acme LLC',
      contact: 'Ruben',
      phone: null,
      email: null,
      address: null,
    }
    expect(shipToWorthPrinting(billTo, shipTo)).toBe(shipTo)
  })

  it('has nothing to say about a missing ship to', () => {
    expect(shipToWorthPrinting(billTo, null)).toBeNull()
  })
})

describe('documentFilename', () => {
  it('names the file after the document', () => {
    expect(documentFilename('PO-0001')).toBe('PO-0001.pdf')
    expect(documentFilename('PO-Acme-0002')).toBe('PO-Acme-0002.pdf')
  })

  it('keeps two numbers from reducing to one filename', () => {
    expect(documentFilename('PO/0001')).not.toBe(documentFilename('PO/0002'))
  })

  it('replaces what a filesystem would object to', () => {
    expect(documentFilename('PO/../etc/passwd')).toBe('PO-..-etc-passwd.pdf')
    expect(documentFilename('INV 0001')).toBe('INV-0001.pdf')
  })

  it('still produces a filename when the number is all punctuation', () => {
    expect(documentFilename('///')).toBe('document.pdf')
  })
})

describe('partyIsEmpty', () => {
  /*
   * The bug this pins: a sales order with no company saved against it built
   * a party object of five nulls, which is truthy, so the document printed an
   * empty bordered CUSTOMER box.
   */
  it('calls a party of nothing empty', () => {
    expect(
      partyIsEmpty({ company: null, contact: null, phone: null, email: null }),
    ).toBe(true)
  })

  it('calls a missing party empty', () => {
    expect(partyIsEmpty(null)).toBe(true)
  })

  it('is not fooled by whitespace', () => {
    expect(partyIsEmpty({ company: '  ', contact: '', phone: null, email: null })).toBe(true)
  })

  it('any one field is enough to be worth printing', () => {
    expect(partyIsEmpty({ company: 'ACME', contact: null, phone: null, email: null })).toBe(false)
    expect(partyIsEmpty({ company: null, contact: 'Paulina', phone: null, email: null })).toBe(false)
    expect(partyIsEmpty({ company: null, contact: null, phone: '615', email: null })).toBe(false)
    expect(partyIsEmpty({ company: null, contact: null, phone: null, email: 'a@b.c' })).toBe(false)
    expect(
      partyIsEmpty({ company: null, contact: null, phone: null, email: null, address: '12 Dock Rd' }),
    ).toBe(false)
  })
})

describe('salesOrderDetails', () => {
  const full = {
    location: 'Centerville',
    representative: 'AFM',
    paymentTerms: 'COD',
    currency: 'USD',
    shipping: 'Seller Delivery',
    shippingMethod: 'Truck',
  }

  it('labels each field with the name the card uses', () => {
    expect(salesOrderDetails(full)).toEqual([
      { label: 'Location', value: 'Centerville' },
      { label: 'Representative', value: 'AFM' },
      { label: 'Payment Terms', value: 'COD' },
      { label: 'Currency', value: 'USD' },
      { label: 'Shipping', value: 'Seller Delivery' },
      { label: 'Shipping method', value: 'Truck' },
    ])
  })

  /*
   * The bug this pins. "Shipping" read shipping_method, so an order carrying
   * FOB against who ships and nothing against how printed no Shipping row —
   * the value was there, the document just asked the wrong field for it.
   */
  it('prints Shipping from who ships, not from the method', () => {
    const details = salesOrderDetails({ ...full, shipping: 'FOB', shippingMethod: null })
    expect(details).toContainEqual({ label: 'Shipping', value: 'FOB' })
    expect(details.map((d) => d.label)).not.toContain('Shipping method')
  })

  it('prints the method on its own when only that is set', () => {
    const details = salesOrderDetails({ ...full, shipping: null, shippingMethod: 'Plane' })
    expect(details).toContainEqual({ label: 'Shipping method', value: 'Plane' })
    expect(details.map((d) => d.label)).not.toContain('Shipping')
  })

  it('says nothing about an order nobody has answered', () => {
    expect(
      salesOrderDetails({
        location: null,
        representative: null,
        paymentTerms: null,
        currency: null,
        shipping: null,
        shippingMethod: null,
      }),
    ).toEqual([])
  })
})
