import { describe, expect, it } from 'vitest'

import { documentDetails, documentFilename, shipToWorthPrinting } from '@/lib/document'
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
