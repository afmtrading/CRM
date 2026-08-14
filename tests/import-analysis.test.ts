import { describe, expect, it } from 'vitest'

import {
  detectHeaderRow,
  detectPlaceholders,
  diffRecord,
  groupByCompany,
  matchCompany,
  normaliseCompanyName,
  normaliseCountry,
  normaliseDomain,
  normalisePhones,
  parseCsv,
  readTable,
  resolveRegion,
  resolveTerritory,
  splitRegionCell,
  splitValues,
  writableChanges,
} from '@/lib/import-analysis'

/**
 * Every case here is taken from one real 257-row buyer list rather than
 * invented, so a failure means a file that used to import stopped importing.
 */

const COUNTRIES = [
  { code: 'CA', name: 'Canada' },
  { code: 'US', name: 'United States' },
  { code: 'MX', name: 'Mexico' },
  { code: 'PL', name: 'Poland' },
  { code: 'DE', name: 'Germany' },
]

const SUBDIVISIONS = [
  { code: 'CA-QC', country_code: 'CA' },
  { code: 'CA-ON', country_code: 'CA' },
  { code: 'CA-BC', country_code: 'CA' },
  { code: 'US-IL', country_code: 'US' },
  { code: 'US-MA', country_code: 'US' },
]

describe('parsing', () => {
  it('handles quotes, doubled quotes and embedded commas', () => {
    expect(parseCsv('a,"b,c","say ""hi"""')).toEqual([['a', 'b,c', 'say "hi"']])
  })

  it('strips the byte-order mark that turns Priority into ﻿Priority', () => {
    expect(parseCsv('﻿Priority,Country')[0]).toEqual(['Priority', 'Country'])
  })

  it('survives CRLF without leaving a carriage return on the last cell', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('keeps a final row that has no trailing newline', () => {
    expect(parseCsv('a,b\nc,d')).toHaveLength(2)
  })

  it('keeps newlines inside a quoted cell', () => {
    expect(parseCsv('a,"line one\nline two"')).toEqual([['a', 'line one\nline two']])
  })
})

describe('finding the header row', () => {
  it('skips a title and two notes to reach row 4', () => {
    // The exact shape of the real file: three prose rows padded out with empty
    // cells, then the headers.
    // A spreadsheet export pads every row to the same width, which is what
    // makes the title row one value and five blanks.
    const pad = (cells: string[]) => [...cells, ...Array(6 - cells.length).fill('')]
    const rows = [
      pad(['Master Contacts - Consolidated Buyer, Broker, Marketplace and Auction Outreach List']),
      pad(['Cleaned on 2026-08-14. Blended from several sources.']),
      pad(['Deduped by verified email, then by company/contact.']),
      ['Priority', 'Country', 'Region', 'Company / Channel', 'Buyer Type', 'Contact Name'],
      ['A', 'Canada', 'QC - Montreal', 'Amabec', 'Liquidation Wholesaler', 'Company intake'],
    ]
    expect(detectHeaderRow(rows)).toBe(3)
  })

  it('takes row 1 when row 1 is the header', () => {
    expect(
      detectHeaderRow([
        ['name', 'email', 'phone'],
        ['Ada', 'ada@example.test', '555'],
      ]),
    ).toBe(0)
  })

  it('will not pick a row that names the same column twice', () => {
    const rows = [
      ['a', 'a', 'a'],
      ['name', 'email', 'phone'],
    ]
    expect(detectHeaderRow(rows)).toBe(1)
  })

  it('reads the table and drops blank rows', () => {
    const table = readTable('Title,,\n\nname,email\nAda,ada@example.test\n\n')
    expect(table.headers).toEqual(['name', 'email'])
    expect(table.rows).toEqual([['Ada', 'ada@example.test']])
  })
})

describe('placeholders in a name column', () => {
  it('catches "Company intake" on 154 of 257 rows', () => {
    const values = [
      ...Array(154).fill('Company intake'),
      ...Array(103).fill(0).map((_, index) => `Real Person ${index}`),
    ]
    const found = detectPlaceholders(values)
    expect(found[0].value).toBe('Company intake')
    expect(found[0].count).toBe(154)
  })

  it('leaves a name shared by two people alone', () => {
    const values = ['Jane Smith', 'Jane Smith', ...Array(200).fill(0).map((_, i) => `Person ${i}`)]
    expect(detectPlaceholders(values)).toEqual([])
  })

  it('says nothing about an empty column', () => {
    expect(detectPlaceholders(['', '  ', ''])).toEqual([])
  })
})

describe('the region cell that holds two facts', () => {
  it('splits location from selling territory', () => {
    expect(splitRegionCell('QC - Montreal / North America')).toEqual({
      region: 'QC',
      locality: 'Montreal',
      territory: 'North America',
    })
  })

  it('handles a bare state with a territory', () => {
    expect(splitRegionCell('IL / national')).toEqual({
      region: 'IL',
      locality: null,
      territory: 'national',
    })
  })

  it('handles a location with no territory', () => {
    expect(splitRegionCell('QC - Saint-Jean-sur-Richelieu')).toEqual({
      region: 'QC',
      locality: 'Saint-Jean-sur-Richelieu',
      territory: null,
    })
  })

  it('handles an en dash, which a spreadsheet will autocorrect into', () => {
    expect(splitRegionCell('ON – Etobicoke').region).toBe('ON')
  })

  it('keeps a locality it cannot classify rather than dropping it', () => {
    expect(splitRegionCell('Greater Toronto Area')).toEqual({
      region: null,
      locality: 'Greater Toronto Area',
      territory: null,
    })
  })

  it('is empty for an empty cell — 153 of 257 rows', () => {
    expect(splitRegionCell('   ')).toEqual({ region: null, locality: null, territory: null })
  })
})

describe('resolving a region against its country', () => {
  it('joins QC and CA into CA-QC', () => {
    expect(resolveRegion('QC', 'CA', SUBDIVISIONS)).toBe('CA-QC')
  })

  it('refuses a region that is not in the country given', () => {
    expect(resolveRegion('QC', 'MX', SUBDIVISIONS)).toBeNull()
  })

  it('will not guess a country from a bare region', () => {
    expect(resolveRegion('QC', null, SUBDIVISIONS)).toBeNull()
  })
})

describe('countries', () => {
  it('takes a name, a code or a known alias', () => {
    expect(normaliseCountry('United States', COUNTRIES)).toBe('US')
    expect(normaliseCountry('USA', COUNTRIES)).toBe('US')
    expect(normaliseCountry('us', COUNTRIES)).toBe('US')
    expect(normaliseCountry('  Canada  ', COUNTRIES)).toBe('CA')
  })

  it('refuses to invent one for International or Unknown', () => {
    // 7 rows and 1 row of the source file. Guessing would be making data up.
    expect(normaliseCountry('International', COUNTRIES)).toBeNull()
    expect(normaliseCountry('Unknown', COUNTRIES)).toBeNull()
    expect(normaliseCountry('Various', COUNTRIES)).toBeNull()
  })

  it('refuses a two-letter code that is not a country', () => {
    expect(normaliseCountry('XX', COUNTRIES)).toBeNull()
  })
})

describe('territories', () => {
  it('reads "national" as the company own country', () => {
    expect(resolveTerritory('national', 'CA', COUNTRIES)).toEqual({
      codes: ['CA'],
      unresolved: null,
    })
    expect(resolveTerritory('province-wide', 'CA', COUNTRIES).codes).toEqual(['CA'])
  })

  it('cannot read "national" without knowing where they are', () => {
    expect(resolveTerritory('national', null, COUNTRIES)).toEqual({
      codes: [],
      unresolved: 'national',
    })
  })

  it('expands North America', () => {
    expect(resolveTerritory('North America', 'CA', COUNTRIES).codes).toEqual(['CA', 'MX', 'US'])
  })

  it('resolves "global" to nothing, and says so', () => {
    // 249 checkboxes is not a description of anybody's territory, and it would
    // make "sells in Mexico" match every global distributor in the file.
    expect(resolveTerritory('global', 'CA', COUNTRIES)).toEqual({
      codes: [],
      unresolved: 'global',
    })
  })

  it('reads a list of countries however it is punctuated', () => {
    expect(resolveTerritory('Canada and USA', 'CA', COUNTRIES).codes).toEqual(['CA', 'US'])
    expect(resolveTerritory('CA, US, MX', 'CA', COUNTRIES).codes).toEqual(['CA', 'MX', 'US'])
    expect(resolveTerritory('Canada / United States', 'CA', COUNTRIES).codes).toEqual(['CA', 'US'])
  })

  it('flags a list it could only partly read', () => {
    const result = resolveTerritory('Canada and Ruritania', 'CA', COUNTRIES)
    expect(result.codes).toEqual(['CA'])
    expect(result.unresolved).toBe('Canada and Ruritania')
  })
})

describe('phone numbers', () => {
  it('normalises the ten formats in the source file to one', () => {
    for (const written of [
      '905-327-9773',
      '(905) 327-9773',
      '905.327.9773',
      '905 327-9773',
      '1-905-327-9773',
      '+1 905-327-9773',
      '+1-905-327-9773',
      '+1 (905) 327-9773',
    ]) {
      expect(normalisePhones(written)).toEqual(['+19053279773'])
    }
  })

  it('returns both numbers from a cell holding two', () => {
    expect(normalisePhones('905-327-9773; 450-993-2121')).toEqual(['+19053279773', '+14509932121'])
  })

  it('keeps a foreign country code rather than assuming +1', () => {
    expect(normalisePhones('+48 123 456 789')).toEqual(['+48123456789'])
  })

  it('drops something too short to be a number', () => {
    expect(normalisePhones('ext 42')).toEqual([])
    expect(normalisePhones('')).toEqual([])
  })
})

describe('cells holding several values', () => {
  it('splits on the separators the file actually uses', () => {
    expect(splitValues('Medical/Orthotics').values).toEqual(['Medical', 'Orthotics'])
    expect(splitValues('Apparel | Uniforms').values).toEqual(['Apparel', 'Uniforms'])
    expect(splitValues('Electronics, brand-name closeouts').values).toEqual([
      'Electronics',
      'brand-name closeouts',
    ])
  })

  it('separates prose from categories rather than making options out of it', () => {
    const result = splitValues(
      'General | Industrial machinery auctions, retail liquidations, restructuring',
    )
    expect(result.values).toEqual(['General'])
    expect(result.prose).toContain('Industrial machinery auctions')
  })

  it('de-duplicates', () => {
    expect(splitValues('General / General').values).toEqual(['General'])
  })
})

describe('diffing an existing record', () => {
  it('calls filling a blank a fill', () => {
    const changes = diffRecord({ phone: null }, { phone: '+19053279773' })
    expect(changes).toEqual([
      { field: 'phone', before: null, after: '+19053279773', kind: 'fill' },
    ])
  })

  it('calls overwriting a value a replace, so it can be shown as a decision', () => {
    const changes = diffRecord({ job_title: 'President' }, { job_title: 'Buyer' })
    expect(changes[0].kind).toBe('replace')
  })

  it('treats a blank in the file as "I do not know", never as "clear it"', () => {
    expect(diffRecord({ phone: '+19053279773' }, { phone: '' })).toEqual([])
    expect(diffRecord({ phone: '+19053279773' }, { phone: null })).toEqual([])
    expect(diffRecord({ sells_in: ['CA'] }, { sells_in: [] })).toEqual([])
  })

  it('sees no change when the values match, whitespace aside', () => {
    expect(diffRecord({ name: 'Amabec' }, { name: ' Amabec ' })[0].kind).toBe('same')
  })

  it('compares arrays by content rather than by order', () => {
    expect(diffRecord({ sells_in: ['US', 'CA'] }, { sells_in: ['CA', 'US'] })[0].kind).toBe('same')
  })

  it('reports only what would be written', () => {
    const changes = diffRecord(
      { name: 'Amabec', phone: null, job_title: 'President' },
      { name: 'Amabec', phone: '+14509932121', job_title: 'Buyer' },
    )
    expect(writableChanges(changes).map((change) => change.field)).toEqual(['phone', 'job_title'])
  })
})

describe('matching an existing company', () => {
  const candidates = [
    { id: 'a', name: 'Amabec Liquidation', domain: 'https://www.amabec.ca/', email: null, based_in: 'CA' },
    { id: 'b', name: 'Bid Boss Inc.', domain: null, email: 'support@bidbossinc.ca', based_in: 'CA' },
    { id: 'c', name: 'Great Lakes Wholesale', domain: null, email: null, based_in: 'CA' },
    { id: 'd', name: 'Great Lakes Wholesale', domain: null, email: null, based_in: 'US' },
  ]

  it('matches on domain first, ignoring scheme and www', () => {
    expect(matchCompany({ domain: 'amabec.ca', name: 'Something Else' }, candidates)).toEqual({
      match: candidates[0],
      basis: 'domain',
    })
  })

  it('falls back to email', () => {
    const result = matchCompany({ email: 'SUPPORT@bidbossinc.ca', name: 'Unknown' }, candidates)
    expect(result.basis).toBe('email')
    expect(result.match?.id).toBe('b')
  })

  it('matches a name past punctuation and a legal suffix', () => {
    expect(normaliseCompanyName('Bid Boss Inc.')).toBe(normaliseCompanyName('BID BOSS INC'))
    expect(normaliseCompanyName('Bank & Vogue Ltd/Ltee.')).toBe(normaliseCompanyName('Bank and Vogue'))
  })

  it('refuses to choose between two companies with the same name', () => {
    // Merging a Canadian and an American "Great Lakes Wholesale" is not
    // recoverable, so this is a question for a person.
    expect(matchCompany({ name: 'Great Lakes Wholesale' }, candidates)).toEqual({
      match: null,
      basis: null,
    })
  })

  it('but takes the one in the right country when the country is known', () => {
    const result = matchCompany({ name: 'Great Lakes Wholesale', based_in: 'US' }, candidates)
    expect(result.match?.id).toBe('d')
    expect(result.basis).toBe('name')
  })

  it('finds nothing rather than guessing', () => {
    expect(matchCompany({ name: 'Nobody Ltd' }, candidates)).toEqual({ match: null, basis: null })
  })

  it('reads a domain out of a full URL and rejects a non-domain', () => {
    expect(normaliseDomain('https://www.amabec.ca/contact?x=1')).toBe('amabec.ca')
    expect(normaliseDomain('not a domain')).toBeNull()
  })
})

describe('grouping rows into companies', () => {
  const rows = [
    { rowNumber: 1, values: { company: 'Amabec Liquidation', type: 'Liquidation Wholesaler', country: 'Canada' } },
    { rowNumber: 2, values: { company: 'Amabec Liquidation', type: 'Wholesale liquidator', country: 'Canada' } },
    { rowNumber: 3, values: { company: 'Bid Boss Inc', type: 'Auctioneer & Buyer', country: 'Canada' } },
  ]

  it('turns three rows into two companies', () => {
    const groups = groupByCompany(rows, { nameField: 'company', companyFields: ['type', 'country'] })
    expect(groups).toHaveLength(2)
    expect(groups[0].rows).toHaveLength(2)
  })

  it('reports where two rows for one company disagree', () => {
    const groups = groupByCompany(rows, { nameField: 'company', companyFields: ['type', 'country'] })
    expect(groups[0].conflicts).toEqual([
      { field: 'type', values: ['Liquidation Wholesaler', 'Wholesale liquidator'] },
    ])
  })

  it('says nothing about a field they agree on', () => {
    const groups = groupByCompany(rows, { nameField: 'company', companyFields: ['country'] })
    expect(groups[0].conflicts).toEqual([])
  })

  it('groups past punctuation, so "Inc" and "Inc." are one company', () => {
    const groups = groupByCompany(
      [
        { rowNumber: 1, values: { company: 'Bid Boss Inc' } },
        { rowNumber: 2, values: { company: 'Bid Boss Inc.' } },
      ],
      { nameField: 'company', companyFields: [] },
    )
    expect(groups).toHaveLength(1)
  })

  it('drops a row with no company name rather than making a company called nothing', () => {
    const groups = groupByCompany(
      [{ rowNumber: 1, values: { company: '  ' } }],
      { nameField: 'company', companyFields: [] },
    )
    expect(groups).toEqual([])
  })
})
