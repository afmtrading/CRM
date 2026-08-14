import { describe, expect, it } from 'vitest'

import { applyMerges, clusterValues, proposeOptions } from '@/lib/import-vocabulary'
import { runChecks } from '@/lib/import-checks'

describe('proposing options', () => {
  it('counts what is missing and ignores what is already there', () => {
    const proposal = proposeOptions(
      'specialty_market',
      'Merchandise',
      ['General', 'General', 'Medical', 'Retail'],
      ['Retail'],
    )
    expect(proposal.missing).toEqual([
      { value: 'General', count: 2 },
      { value: 'Medical', count: 1 },
    ])
    expect(proposal.known).toBe(1)
  })

  it('matches what is already there without regard to case', () => {
    // Proposing "general" when the list holds "General" is how a list ends up
    // holding both.
    const proposal = proposeOptions('x', 'X', ['general'], ['General'])
    expect(proposal.missing).toEqual([])
    expect(proposal.known).toBe(1)
  })

  it('puts the commonest first', () => {
    const proposal = proposeOptions('x', 'X', ['a', 'b', 'b', 'b', 'c', 'c'], [])
    expect(proposal.missing.map((entry) => entry.value)).toEqual(['b', 'c', 'a'])
  })
})

describe('clustering near-duplicates', () => {
  const counts = (...pairs: [string, number][]) =>
    pairs.map(([value, count]) => ({ value, count }))

  it('brings the spellings of one thing together', () => {
    const clusters = clusterValues(counts(['Marketplace/Platform', 7], ['PLATFORM', 3]))
    expect(clusters).toHaveLength(1)
    // The commonest spelling is usually the house spelling.
    expect(clusters[0].keep).toBe('Marketplace/Platform')
    expect(clusters[0].total).toBe(10)
  })

  it('stops at the edge where it would be guessing', () => {
    /*
     * "Directory/Marketplace" and "Marketplace/Platform" share one word out of
     * three. Whether they are the same category is a judgement, and this is
     * deliberately not the thing making it: over-merging silently destroys a
     * distinction, while leaving them apart costs one decision that is then
     * remembered in the profile.
     */
    const clusters = clusterValues(
      counts(['Marketplace/Platform', 7], ['Directory/Marketplace', 11]),
    )
    expect(clusters).toHaveLength(2)
  })

  it('leaves two different things apart', () => {
    // One shared word out of three is not enough to call these the same.
    const clusters = clusterValues(
      counts(['Liquidation Wholesaler', 44], ['Distributor/Wholesaler', 43]),
    )
    expect(clusters).toHaveLength(2)
  })

  it('matches a word to its longer form', () => {
    const clusters = clusterValues(counts(['Auction House', 4], ['Auctioneer House', 2]))
    expect(clusters).toHaveLength(1)
  })

  it('will not match on a short prefix', () => {
    // "pro" inside "product" would cluster half a catalogue.
    const clusters = clusterValues(counts(['Pro Buyer', 3], ['Product Buyer', 2]))
    expect(clusters).toHaveLength(2)
  })

  it('ignores joining words when deciding', () => {
    const clusters = clusterValues(counts(['Returns and Overstock', 5], ['Overstock', 9]))
    expect(clusters).toHaveLength(1)
    expect(clusters[0].keep).toBe('Overstock')
  })

  it('puts the clusters that need a decision first', () => {
    const clusters = clusterValues(
      counts(['Alone', 50], ['Marketplace/Platform', 2], ['PLATFORM', 1]),
    )
    expect(clusters[0].members).toHaveLength(2)
    expect(clusters[1].members).toHaveLength(1)
  })
})

describe('applying merges', () => {
  it('rewrites what has a rule', () => {
    expect(applyMerges(['PLATFORM'], { PLATFORM: 'Marketplace' })).toEqual(['Marketplace'])
  })

  it('matches the rule without regard to case', () => {
    expect(applyMerges(['platform'], { PLATFORM: 'Marketplace' })).toEqual(['Marketplace'])
  })

  it('leaves a value with no rule alone rather than dropping it', () => {
    // A merge table is a set of corrections, not a whitelist. Treating it as
    // one would make every new value vanish the moment a profile existed.
    expect(applyMerges(['Something New'], { PLATFORM: 'Marketplace' })).toEqual(['Something New'])
  })

  it('de-duplicates what two rules merge onto one value', () => {
    expect(applyMerges(['PLATFORM', 'Platforms'], { PLATFORM: 'Marketplace', Platforms: 'Marketplace' })).toEqual([
      'Marketplace',
    ])
  })
})

describe('the checks', () => {
  const headers = ['Company', 'Email', 'Phone', 'Website', 'Status']
  const row = (rowNumber: number, values: Partial<Record<string, string>>) => ({
    rowNumber,
    values: Object.fromEntries(headers.map((header) => [header, values[header] ?? ''])),
  })
  const mapping = {
    Company: 'company.name',
    Email: 'contact.email',
    Phone: 'contact.phone',
    Website: 'company.domain',
  }

  it('counts the rows nobody can reach', () => {
    const checks = runChecks({
      headers,
      mapping,
      rows: [
        row(2, { Company: 'A', Email: 'a@a.test' }),
        row(3, { Company: 'B', Website: 'b.test' }),
        row(4, { Company: 'C' }),
      ],
    })
    const check = checks.find((entry) => entry.id === 'unreachable')
    expect(check?.count).toBe(2)
    expect(check?.headline).toContain('2 of 3')
    expect(check?.detail).toContain('1 of them do have a website')
  })

  it('separates a call list from an email list', () => {
    const checks = runChecks({
      headers,
      mapping,
      rows: [row(2, { Company: 'A', Phone: '555-000-0000' }), row(3, { Company: 'B', Email: 'b@b.test' })],
    })
    expect(checks.find((entry) => entry.id === 'phone-only')?.count).toBe(1)
  })

  it('catches an address on two rows', () => {
    const checks = runChecks({
      headers,
      mapping,
      rows: [
        row(2, { Company: 'A', Email: 'same@a.test' }),
        row(3, { Company: 'B', Email: 'SAME@a.test' }),
      ],
    })
    expect(checks.find((entry) => entry.id === 'duplicate-emails')?.count).toBe(1)
  })

  it('names a column that says the same thing on every row', () => {
    const checks = runChecks({
      headers,
      mapping,
      rows: [
        row(2, { Company: 'A', Status: 'To contact', Email: 'a@a.test' }),
        row(3, { Company: 'B', Status: 'To contact', Email: 'b@b.test' }),
      ],
    })
    const check = checks.find((entry) => entry.id === 'constant-columns')
    expect(check?.detail).toContain('Status')
  })

  it('says which columns with data are being left behind', () => {
    const checks = runChecks({
      headers,
      mapping,
      rows: [row(2, { Company: 'A', Email: 'a@a.test', Status: 'To contact' })],
    })
    expect(checks.find((entry) => entry.id === 'unmapped')?.detail).toContain('Status')
  })

  it('notices a free address at a company with its own domain', () => {
    const checks = runChecks({
      headers,
      mapping,
      rows: [row(2, { Company: 'A', Email: 'buyer@gmail.com', Website: 'acme.test' })],
    })
    expect(checks.find((entry) => entry.id === 'free-email')?.count).toBe(1)
  })

  it('puts what needs doing above what is merely true', () => {
    const checks = runChecks({
      headers,
      mapping,
      rows: [row(2, { Company: 'A', Status: 'To contact' }), row(3, { Company: 'B', Status: 'To contact' })],
    })
    const firstNote = checks.findIndex((entry) => entry.severity === 'note')
    const lastWarning = checks.map((entry) => entry.severity).lastIndexOf('warning')
    expect(lastWarning).toBeLessThan(firstNote)
  })

  it('says nothing about an empty file', () => {
    expect(runChecks({ headers, mapping, rows: [] })).toEqual([])
  })
})
