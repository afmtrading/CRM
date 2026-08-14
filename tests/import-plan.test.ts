import { describe, expect, it } from 'vitest'

import { buildPlan, readRow, suggestTargets, type ReadContext } from '@/lib/import-plan'

const CONTEXT: ReadContext = {
  countries: [
    { code: 'CA', name: 'Canada' },
    { code: 'US', name: 'United States' },
    { code: 'MX', name: 'Mexico' },
  ],
  subdivisions: [
    { code: 'CA-QC', country_code: 'CA' },
    { code: 'CA-ON', country_code: 'CA' },
    { code: 'US-IL', country_code: 'US' },
  ],
  placeholders: new Set(['Company intake']),
}

/** The mapping the suggester produces for the real file, spelled out. */
const MAPPING: Record<string, string> = {
  'Company / Channel': 'company.name',
  'Company / Contact URL': 'company.domain',
  Country: 'company.based_in',
  Region: 'company.region',
  'Buyer Type': 'company.customer_type',
  'Merchandise Fit': 'company.specialty_market',
  'Contact Name': 'contact.name',
  'Title / Department': 'contact.job_title',
  Email: 'contact.email',
  Phone: 'contact.phone',
}

describe('suggesting a mapping', () => {
  it('sends the two URL columns to the right places', () => {
    // Both contain "URL". Order of the hints is what keeps them apart, and both
    // headings are real ones from a real file.
    const mapping = suggestTargets(['Company / Contact URL', 'LinkedIn / Person URL'])
    expect(mapping['Company / Contact URL']).toBe('company.domain')
    expect(mapping['LinkedIn / Person URL']).toBe('contact.linkedin')
  })

  it('does not let "Company / Contact URL" claim the company name', () => {
    const mapping = suggestTargets(['Company / Contact URL', 'Company / Channel'])
    expect(mapping['Company / Channel']).toBe('company.name')
  })

  it('leaves alone the columns that are not CRM fields', () => {
    const mapping = suggestTargets([
      'Best Outreach Channel',
      'Pitch Angle / Inventory Fit',
      'Source Tabs',
      'Buyer Fit Score',
    ])
    expect(mapping).toEqual({})
  })

  it('claims a target once, so a second email column waits for a person', () => {
    const mapping = suggestTargets(['Email', 'Backup Email'])
    expect(mapping.Email).toBe('contact.email')
    expect(mapping['Backup Email']).toBeUndefined()
  })
})

describe('reading a row', () => {
  const row = (values: Record<string, string>) => readRow(5, values, MAPPING, CONTEXT)

  it('splits the region cell into where they are and where they sell', () => {
    const read = row({
      'Company / Channel': 'C3',
      Country: 'Canada',
      Region: 'QC - Montreal / North America',
    })
    expect(read.company.based_in).toBe('CA')
    expect(read.company.based_in_region).toBe('CA-QC')
    expect(read.company.sells_in).toEqual(['CA', 'MX', 'US'])
  })

  it('reads "national" as the company own country', () => {
    const read = row({ 'Company / Channel': 'X', Country: 'Canada', Region: 'ON - Niagara / national' })
    expect(read.company.sells_in).toEqual(['CA'])
  })

  it('makes a company channel out of a placeholder row rather than a nameless person', () => {
    const read = row({
      'Company / Channel': 'Amabec Liquidation',
      'Contact Name': 'Company intake',
      Email: 'sales@amabec.ca',
      Phone: '+1-450-993-2121',
    })

    // The worst outcome would be a contact with an address and no name: a
    // person who does not exist and cannot be greeted by name.
    expect(read.contact).toBeNull()
    expect(read.company.email).toBe('sales@amabec.ca')
    expect(read.company.phone).toBe('+14509932121')
    expect(read.notes.join(' ')).toContain('placeholder')
  })

  it('keeps a real person, particles and all', () => {
    const read = row({
      'Company / Channel': 'C3',
      'Contact Name': 'Justinian La Rosa',
      'Title / Department': 'Business Development Manager',
    })
    expect(read.contact).toMatchObject({ first_name: 'Justinian', last_name: 'La Rosa' })
  })

  it('warns about what it could not read, and only notes what it could', () => {
    const read = row({
      'Company / Channel': 'X',
      Country: 'International',
      Phone: 'ext 42',
    })
    expect(read.warnings).toHaveLength(2)
    expect(read.warnings.join(' ')).toContain('International')
    expect(read.notes).toEqual([])
  })

  it('drops a row with a title but no name', () => {
    const read = row({ 'Company / Channel': 'X', 'Title / Department': 'Purchasing' })
    expect(read.contact).toBeNull()
  })
})

describe('building the plan', () => {
  const rows: { rowNumber: number; values: Record<string, string> }[] = [
    {
      rowNumber: 5,
      values: {
        'Company / Channel': 'Amabec Liquidation',
        Country: 'Canada',
        Region: 'QC - Saint-Jean-sur-Richelieu',
        'Merchandise Fit': 'General',
        'Contact Name': 'Company intake',
        Email: 'sales@amabec.ca',
      },
    },
    {
      rowNumber: 6,
      values: {
        'Company / Channel': 'Amabec Liquidation.',
        Country: 'Canada',
        'Merchandise Fit': 'Medical',
        'Contact Name': 'Ada Lovelace',
        Email: 'ada@amabec.ca',
      },
    },
    {
      rowNumber: 7,
      values: {
        'Company / Channel': 'Bid Boss Inc',
        Country: 'Canada',
        'Contact Name': 'Company intake',
        Email: 'support@bidbossinc.ca',
      },
    },
  ]

  it('turns three rows into two companies', () => {
    const plan = buildPlan(rows, MAPPING, CONTEXT, [])
    expect(plan.counts.newCompanies).toBe(2)
    expect(plan.counts.rows).toBe(3)
  })

  it('adds up the list fields across a company rows rather than picking one', () => {
    // Selling apparel on one row and uniforms on another means both, unlike a
    // single-valued field where two rows compete.
    const plan = buildPlan(rows, MAPPING, CONTEXT, [])
    const amabec = plan.companies.find((company) => company.name.startsWith('Amabec'))
    expect(amabec?.values.specialty_market).toEqual(['General', 'Medical'])
  })

  it('counts only the real people', () => {
    const plan = buildPlan(rows, MAPPING, CONTEXT, [])
    expect(plan.counts.contacts).toBe(1)
  })

  it('matches an existing company and reports the change as a fill', () => {
    const plan = buildPlan(rows, MAPPING, CONTEXT, [
      { id: 'existing', name: 'Amabec Liquidation', domain: null, email: null, based_in: null },
    ])

    const amabec = plan.companies.find((company) => company.matchId === 'existing')
    expect(amabec?.matchBasis).toBe('name')
    expect(amabec?.changes.find((change) => change.field === 'based_in')).toMatchObject({
      kind: 'fill',
      after: 'CA',
    })
    expect(plan.counts.updatedCompanies).toBe(1)
    expect(plan.counts.newCompanies).toBe(1)
  })

  it('calls an overwrite an overwrite', () => {
    const plan = buildPlan(rows, MAPPING, CONTEXT, [
      { id: 'existing', name: 'Bid Boss Inc', domain: null, email: 'old@bidbossinc.ca', based_in: 'US' },
    ])

    const bidBoss = plan.companies.find((company) => company.matchId === 'existing')
    expect(bidBoss?.changes.find((change) => change.field === 'based_in')?.kind).toBe('replace')
  })

  it('says nothing to do when the file matches what is already there', () => {
    const plan = buildPlan(
      [rows[2]],
      MAPPING,
      CONTEXT,
      [{ id: 'existing', name: 'Bid Boss Inc', domain: null, email: 'support@bidbossinc.ca', based_in: 'CA' }],
    )
    expect(plan.counts.unchangedCompanies).toBe(1)
    expect(plan.counts.updatedCompanies).toBe(0)
  })

  it('returns an empty plan rather than guessing when no column is the company name', () => {
    const plan = buildPlan(rows, { Email: 'contact.email' }, CONTEXT, [])
    expect(plan.companies).toEqual([])
    expect(plan.counts.rows).toBe(3)
  })
})
