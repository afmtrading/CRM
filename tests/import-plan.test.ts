import { describe, expect, it } from 'vitest'

import {
  buildPlan,
  importTargets,
  readRow,
  suggestTargets,
  type ReadContext,
} from '@/lib/import-plan'

const CONTEXT: ReadContext = {
  countries: [
    { code: 'CA', name: 'Canada' },
    { code: 'US', name: 'United States' },
    { code: 'MX', name: 'Mexico' },
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

  /*
   * Separators are punctuation, not part of the word. A file writing
   * `stock_type` is naming the same field as one writing "Stock type", and
   * matching on the literal space meant the app failed to recognise its own
   * field names — the whole of somebody's complaint that identical names would
   * not match.
   */
  it('reads a heading the same however it is punctuated', () => {
    const mapping = suggestTargets(['stock_type', 'company_type', 'first-name'])
    expect(mapping.stock_type).toBe('company.stock_type')
    expect(mapping.company_type).toBe('company.customer_type')
    expect(mapping['first-name']).toBe('contact.first_name')
  })

  // The field is called "Base Country". An anchored /^country/ did not match
  // the app's own name for it.
  it('finds the country column whatever qualifies it', () => {
    expect(suggestTargets(['Base Country'])['Base Country']).toBe('company.based_in')
    expect(suggestTargets(['Country'])['Country']).toBe('company.based_in')
  })

  /*
   * A qualified heading beats the generic rule for its kind of value.
   * "Company email" used to be claimed by the bare email rule and land on a
   * person who did not exist.
   */
  it('keeps a company address off the contact', () => {
    const mapping = suggestTargets(['Company email', 'Company phone'])
    expect(mapping['Company email']).toBe('company.email')
    expect(mapping['Company phone']).toBe('company.phone')
  })

  it('offers the fields added since it was written', () => {
    const mapping = suggestTargets(['sells_To', 'Tags', 'notes'])
    expect(mapping.sells_To).toBe('company.sells_in')
    expect(mapping.Tags).toBe('company.tags')
    expect(mapping.notes).toBe('company.notes')
  })

  /*
   * Priority, Owner, Tags and Notes are asked of both records in the same
   * words, so the file decides. Getting this backwards is not a cosmetic
   * mistake: a contact list's Priority pointed at the company would rewrite
   * the priority of every company on it.
   */
  describe('headings that both records share', () => {
    it('gives them to the company when the file names no people', () => {
      const mapping = suggestTargets(['Company name', 'priority', 'owner', 'Tags'])
      expect(mapping.priority).toBe('company.priority')
      expect(mapping.owner).toBe('company.owner_id')
      expect(mapping.Tags).toBe('company.tags')
    })

    it('gives them to the person when it does', () => {
      const mapping = suggestTargets(['first_name', 'last_name', 'company_name', 'priority', 'owner'])
      expect(mapping.priority).toBe('contact.priority')
      expect(mapping.owner).toBe('contact.owner_id')
      // The company column is still the company's, which is what joins the two.
      expect(mapping.company_name).toBe('company.name')
    })
  })
})

describe('reading a row', () => {
  const row = (values: Record<string, string>) => readRow(5, values, MAPPING, CONTEXT)

  /*
   * The file still puts two facts in one cell. Only the second half has a home
   * now that the subdivision column is gone, so the province is read and
   * dropped rather than warned about — the spreadsheet did not change, the app
   * stopped asking.
   */
  it('takes the territory out of the region cell and lets the province go', () => {
    const read = row({
      'Company / Channel': 'C3',
      Country: 'Canada',
      Region: 'QC - Montreal / North America',
    })
    expect(read.company.based_in).toBe('CA')
    expect(read.company.sells_in).toEqual(['CA', 'MX', 'US'])
    expect(read.warnings.some((warning) => warning.includes('QC'))).toBe(false)
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

/* -------------------------------------------------------------------------- */

const USERS = [
  { id: 'u-emile', name: 'Emile Tremblay', email: 'emile@flo.example' },
  { id: 'u-sam', name: 'Sam Okafor', email: 'sam@flo.example' },
]

describe('the columns a list actually arrives with', () => {
  const read = (mapping: Record<string, string>, values: Record<string, string>) =>
    readRow(2, values, mapping, { ...CONTEXT, users: USERS })

  describe('an owner column', () => {
    it('resolves a first name to the one person who answers to it', () => {
      const row = read({ owner: 'company.owner_id' }, { owner: 'Emile' })
      expect(row.company.owner_id).toBe('u-emile')
      expect(row.warnings).toEqual([])
    })

    it('resolves a full name and an email too', () => {
      expect(read({ o: 'company.owner_id' }, { o: 'Emile Tremblay' }).company.owner_id).toBe('u-emile')
      expect(read({ o: 'company.owner_id' }, { o: 'sam@flo.example' }).company.owner_id).toBe('u-sam')
    })

    /*
     * Left unset and said out loud. Assigning somebody's accounts to the wrong
     * rep is worse than assigning them to nobody, and it is invisible after
     * the fact — nothing on the record says the name was a guess.
     */
    it('refuses a name that matches nobody, and says so', () => {
      const row = read({ owner: 'company.owner_id' }, { owner: 'Nobody' })
      expect(row.company.owner_id).toBeUndefined()
      expect(row.warnings).toEqual(['No user called "Nobody" — owner left unset'])
    })

    it('refuses a first name two people share', () => {
      const row = readRow(2, { owner: 'Emile' }, { owner: 'company.owner_id' }, {
        ...CONTEXT,
        users: [...USERS, { id: 'u-other', name: 'Emile Roy', email: 'roy@flo.example' }],
      })
      expect(row.company.owner_id).toBeUndefined()
      expect(row.warnings[0]).toContain('More than one person')
    })
  })

  describe('a sells-to column', () => {
    it('reads a list of countries to codes', () => {
      const row = read({ sells_To: 'company.sells_in' }, { sells_To: 'Canada; Mexico; USA' })
      expect(row.company.sells_in).toEqual(['CA', 'MX', 'US'])
    })

    it('warns rather than silently dropping what it cannot place', () => {
      const row = read({ sells_To: 'company.sells_in' }, { sells_To: 'Worldwide' })
      expect(row.company.sells_in).toBeUndefined()
      expect(row.warnings[0]).toContain('Worldwide')
    })

    /*
     * A column of its own is the better statement of the fact than a territory
     * smuggled in after a slash, so it wins. Both said different things here
     * and the explicit one is what survives.
     */
    it('is not overwritten by a territory hidden in the region cell', () => {
      const row = read(
        { sells_To: 'company.sells_in', Region: 'company.region' },
        { sells_To: 'Canada', Region: 'Quebec / North America' },
      )
      expect(row.company.sells_in).toEqual(['CA'])
    })
  })

  describe('tags', () => {
    it('keeps them off the value bag, which is written as columns', () => {
      const row = read({ Tags: 'company.tags' }, { Tags: 'Orthotics; Look' })
      expect(row.companyTags).toEqual(['Orthotics', 'Look'])
      expect(row.company.tags).toBeUndefined()
    })

    it('gives a row with no person on it its tags as the company\'s', () => {
      const row = read(
        { Name: 'contact.name', Tags: 'contact.tags' },
        { Name: 'Company intake', Tags: 'Orthotics' },
      )
      expect(row.contact).toBeNull()
      expect(row.companyTags).toEqual(['Orthotics'])
    })
  })

  it('reads a field the organization defined for itself', () => {
    const row = readRow(
      2,
      { Buyer_Vendor: 'Buyer; Vendor' },
      { Buyer_Vendor: 'company.custom_fields.buyer_vendor' },
      {
        ...CONTEXT,
        targets: importTargets([
          { key: 'buyer_vendor', label: 'Buyer / Vendor', entity_type: 'company' },
        ]),
      },
    )
    expect(row.company.custom_fields).toEqual({ buyer_vendor: 'Buyer; Vendor' })
  })

  it('takes a first and last name from two columns', () => {
    const row = read(
      { first_name: 'contact.first_name', last_name: 'contact.last_name' },
      { first_name: 'Justinian', last_name: 'La Rosa' },
    )
    expect(row.contact).toMatchObject({ first_name: 'Justinian', last_name: 'La Rosa' })
  })
})
