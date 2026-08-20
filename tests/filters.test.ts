import { describe, expect, it } from 'vitest'

import {
  applyFilter,
  conditionToPredicate,
  dealVisibility,
  EMPTY_FILTER,
  filterFromSearchParams,
  filterToSearchParams,
  groupRows,
  groupRowsNested,
  labelFromFields,
  matchesFilter,
  overlappingGroupField,
  parseFilterConfig,
  sortRows,
  TAGS_FIELD,
  TAGS_FIELD_KEY,
  tagPredicate,
  tagsMatch,
  toColumn,
  type FilterConfig,
  type QueryLike,
} from '@/lib/filters'

/** Records what a filter would send to PostgREST, without needing a database. */
function recordingQuery() {
  const calls: string[] = []
  const query: QueryLike = {
    or(filters) {
      calls.push(`or(${filters})`)
      return query
    },
    filter(column, operator, value) {
      calls.push(`filter(${column},${operator},${value})`)
      return query
    },
    order(column, options) {
      calls.push(`order(${column},${options?.ascending ? 'asc' : 'desc'})`)
      return query
    },
  }
  return { query, calls }
}

describe('toColumn', () => {
  it('leaves standard columns alone', () => {
    expect(toColumn('lead_score')).toBe('lead_score')
  })

  it('addresses custom fields as JSON keys', () => {
    expect(toColumn('custom_fields.tier')).toBe('custom_fields->>tier')
  })
})

describe('conditionToPredicate', () => {
  it('builds an equality predicate', () => {
    expect(conditionToPredicate({ field: 'source', operator: 'eq', value: 'website' })).toEqual({
      expression: 'source.eq.website',
    })
  })

  it('wraps contains in wildcards', () => {
    expect(conditionToPredicate({ field: 'email', operator: 'contains', value: 'acme' })).toEqual({
      expression: 'email.ilike.%acme%',
    })
  })

  it('quotes a wildcard value that itself contains a separator', () => {
    expect(conditionToPredicate({ field: 'email', operator: 'contains', value: 'a.b' })).toEqual({
      expression: 'email.ilike."%a.b%"',
    })
  })

  it('quotes values containing separators', () => {
    expect(conditionToPredicate({ field: 'source', operator: 'eq', value: 'trade show, EU' })).toEqual({
      expression: 'source.eq."trade show, EU"',
    })
  })

  it('needs no value for emptiness checks', () => {
    expect(conditionToPredicate({ field: 'phone', operator: 'is_empty' })).toEqual({
      expression: 'phone.is.null',
    })
    expect(conditionToPredicate({ field: 'phone', operator: 'is_not_empty' })).toEqual({
      expression: 'phone.not.is.null',
    })
  })

  it('drops a condition with no value rather than filtering on empty string', () => {
    expect(conditionToPredicate({ field: 'source', operator: 'eq', value: '' })).toBeNull()
    expect(conditionToPredicate({ field: 'source', operator: 'contains' })).toBeNull()
  })

  it('builds an IN list from an array or a comma-separated string', () => {
    expect(
      conditionToPredicate({ field: 'lifecycle_stage', operator: 'in', value: ['lead', 'customer'] }),
    ).toEqual({ expression: 'lifecycle_stage.in.(lead,customer)' })

    expect(
      conditionToPredicate({ field: 'lifecycle_stage', operator: 'in', value: 'lead, customer' }),
    ).toEqual({ expression: 'lifecycle_stage.in.(lead,customer)' })
  })

  it('filters on a custom field', () => {
    expect(conditionToPredicate({ field: 'custom_fields.tier', operator: 'eq', value: 'gold' })).toEqual({
      expression: 'custom_fields->>tier.eq.gold',
    })
  })
})

describe('applyFilter', () => {
  it('ANDs conditions by default', () => {
    const { query, calls } = recordingQuery()

    applyFilter(
      query,
      {
        match: 'all',
        conditions: [
          { field: 'lifecycle_stage', operator: 'eq', value: 'lead' },
          { field: 'lead_score', operator: 'gte', value: 20 },
        ],
      },
      'contact',
    )

    expect(calls).toContain('filter(lifecycle_stage,eq,lead)')
    expect(calls).toContain('filter(lead_score,gte,20)')
    expect(calls.some((call) => call.startsWith('or('))).toBe(false)
  })

  it('ORs conditions when match is "any"', () => {
    const { query, calls } = recordingQuery()

    applyFilter(
      query,
      {
        match: 'any',
        conditions: [
          { field: 'lifecycle_stage', operator: 'eq', value: 'lead' },
          { field: 'lifecycle_stage', operator: 'eq', value: 'qualified' },
        ],
      },
      'contact',
    )

    expect(calls).toContain('or(lifecycle_stage.eq.lead,lifecycle_stage.eq.qualified)')
  })

  it('searches across the entity’s text columns', () => {
    const { query, calls } = recordingQuery()

    applyFilter(query, { match: 'all', conditions: [], search: 'acme' }, 'contact')

    const search = calls.find((call) => call.startsWith('or('))
    expect(search).toContain('first_name.ilike.%acme%')
    expect(search).toContain('last_name.ilike.%acme%')
    expect(search).toContain('email.ilike.%acme%')
  })

  it('sorts newest-first unless told otherwise', () => {
    const { query: a, calls: defaultCalls } = recordingQuery()
    applyFilter(a, { match: 'all', conditions: [] }, 'contact')
    expect(defaultCalls).toContain('order(created_at,desc)')

    const { query: b, calls: sortedCalls } = recordingQuery()
    applyFilter(b, { match: 'all', conditions: [], sort: { field: 'last_name', direction: 'asc' } }, 'contact')
    expect(sortedCalls).toContain('order(last_name,asc)')
  })

  it('splits predicates correctly when the value itself contains dots', () => {
    const { query, calls } = recordingQuery()

    applyFilter(
      query,
      { match: 'all', conditions: [{ field: 'email', operator: 'eq', value: 'a.b@example.com' }] },
      'contact',
    )

    expect(calls).toContain('filter(email,eq,a.b@example.com)')
  })
})

describe('tagsMatch', () => {
  const held = ['vip', 'reseller']

  it('answers the array operators over the tags a record holds', () => {
    expect(tagsMatch(held, { field: 'tags', operator: 'has_any', value: ['vip', 'lapsed'] })).toBe(true)
    expect(tagsMatch(held, { field: 'tags', operator: 'has_all', value: ['vip', 'lapsed'] })).toBe(false)
    expect(tagsMatch(held, { field: 'tags', operator: 'has_all', value: ['vip', 'reseller'] })).toBe(true)
    expect(tagsMatch(held, { field: 'tags', operator: 'has_none', value: ['lapsed'] })).toBe(true)
    expect(tagsMatch(held, { field: 'tags', operator: 'has_none', value: ['vip'] })).toBe(false)
  })

  it('treats an untagged record as including none of anything', () => {
    expect(tagsMatch([], { field: 'tags', operator: 'has_none', value: ['vip'] })).toBe(true)
    expect(tagsMatch([], { field: 'tags', operator: 'has_any', value: ['vip'] })).toBe(false)
    expect(tagsMatch([], { field: 'tags', operator: 'is_empty' })).toBe(true)
    expect(tagsMatch([], { field: 'tags', operator: 'is_not_empty' })).toBe(false)
  })

  it('compares "is exactly" as a set, not in order', () => {
    expect(tagsMatch(held, { field: 'tags', operator: 'is_exactly', value: ['reseller', 'vip'] })).toBe(true)
    expect(tagsMatch(held, { field: 'tags', operator: 'is_exactly', value: ['vip'] })).toBe(false)
  })

  it('narrows nothing when nothing has been chosen', () => {
    expect(tagsMatch(held, { field: 'tags', operator: 'has_any', value: [] })).toBe(false)
    expect(tagsMatch(held, { field: 'tags', operator: 'has_none', value: [] })).toBe(false)
  })
})

describe('tagPredicate', () => {
  const tagsByRecord = new Map([
    ['a', ['vip']],
    ['b', ['vip', 'reseller']],
    ['c', ['lapsed']],
  ])

  it('names the records that match', () => {
    expect(tagPredicate({ field: 'tags', operator: 'has_any', value: ['vip'] }, tagsByRecord)).toEqual({
      expression: 'id.in.(a,b)',
    })
    expect(tagPredicate({ field: 'tags', operator: 'has_all', value: ['vip', 'reseller'] }, tagsByRecord)).toEqual(
      { expression: 'id.in.(b)' },
    )
  })

  /*
   * The one that cannot be a list of matches: a record with no tags at all is
   * absent from the map, so "includes none of" has to name the records that
   * fail and exclude those instead.
   */
  it('excludes the offenders rather than listing the matches', () => {
    expect(tagPredicate({ field: 'tags', operator: 'has_none', value: ['vip'] }, tagsByRecord)).toEqual({
      expression: 'id.not.in.(a,b)',
    })
    expect(tagPredicate({ field: 'tags', operator: 'is_empty' }, tagsByRecord)).toEqual({
      expression: 'id.not.in.(a,b,c)',
    })
  })

  it('narrows to nothing when no record matches', () => {
    expect(tagPredicate({ field: 'tags', operator: 'has_any', value: ['gone'] }, tagsByRecord)).toEqual({
      expression: 'id.is.null',
    })
  })

  it('narrows nothing when there is nothing to exclude or nothing chosen', () => {
    expect(tagPredicate({ field: 'tags', operator: 'has_none', value: ['gone'] }, tagsByRecord)).toBeNull()
    expect(tagPredicate({ field: 'tags', operator: 'has_any', value: [] }, tagsByRecord)).toBeNull()
    expect(tagPredicate({ field: 'tags', operator: 'is_empty' }, new Map())).toBeNull()
  })
})

describe('tag conditions through applyFilter', () => {
  const tagsByRecord = new Map([
    ['a', ['vip']],
    ['b', ['lapsed']],
  ])

  it('sends the id list the tags resolve to', () => {
    const { query, calls } = recordingQuery()

    applyFilter(
      query,
      { match: 'all', conditions: [{ field: TAGS_FIELD_KEY, operator: 'has_any', value: ['vip'] }] },
      'contact',
      undefined,
      tagsByRecord,
    )

    expect(calls).toContain('filter(id,in,(a))')
  })

  /* `not.in` is two segments; splitting on the first two dots would send `not`. */
  it('keeps a negated operator whole', () => {
    const { query, calls } = recordingQuery()

    applyFilter(
      query,
      { match: 'all', conditions: [{ field: TAGS_FIELD_KEY, operator: 'has_none', value: ['vip'] }] },
      'contact',
      undefined,
      tagsByRecord,
    )

    expect(calls).toContain('filter(id,not.in,(a))')
  })

  it('still sends "is not empty" as a plain negation', () => {
    const { query, calls } = recordingQuery()

    applyFilter(
      query,
      { match: 'all', conditions: [{ field: 'phone', operator: 'is_not_empty' }] },
      'contact',
    )

    expect(calls).toContain('filter(phone,not.is,null)')
  })

  /* Without the join there is nothing to resolve, so the condition is dropped. */
  it('drops a tag condition when the caller has no join to resolve it with', () => {
    const { query, calls } = recordingQuery()

    applyFilter(
      query,
      { match: 'all', conditions: [{ field: TAGS_FIELD_KEY, operator: 'has_any', value: ['vip'] }] },
      'contact',
    )

    expect(calls.some((call) => call.startsWith('filter('))).toBe(false)
  })

  it('reads tags off the row on the in-memory path', () => {
    const config: FilterConfig = {
      match: 'all',
      conditions: [{ field: TAGS_FIELD_KEY, operator: 'has_any', value: ['vip'] }],
    }

    expect(matchesFilter({ id: 'a', tags: ['vip'] }, config, 'marketplace')).toBe(true)
    expect(matchesFilter({ id: 'b', tags: ['lapsed'] }, config, 'marketplace')).toBe(false)
    expect(matchesFilter({ id: 'c', tags: [] }, config, 'marketplace')).toBe(false)
  })
})

describe('groupRows', () => {
  const rows = [
    { id: '1', source: 'website', custom_fields: { tier: 'gold' } },
    { id: '2', source: 'referral', custom_fields: { tier: 'silver' } },
    { id: '3', source: 'website', custom_fields: {} },
    { id: '4', source: null, custom_fields: {} },
  ]

  it('returns a single group when not grouping', () => {
    const groups = groupRows(rows, null)
    expect(groups).toHaveLength(1)
    expect(groups[0].rows).toHaveLength(4)
  })

  it('groups by a standard field', () => {
    const groups = groupRows(rows, 'source')
    expect(groups.map((group) => group.key)).toEqual(['referral', 'website', null])
    expect(groups.find((group) => group.key === 'website')?.rows).toHaveLength(2)
  })

  it('groups by a custom field', () => {
    const groups = groupRows(rows, 'custom_fields.tier')
    expect(groups.map((group) => group.key)).toEqual(['gold', 'silver', null])
  })

  /*
   * What the marketplaces list needs: a company row with its profile embedded,
   * grouped by something that lives on the profile rather than the company.
   */
  it('groups by a field on an embedded row', () => {
    const embedded = [
      { id: '1', marketplace_profiles: { selling_cost: 'Low' } },
      { id: '2', marketplace_profiles: { selling_cost: 'High' } },
      { id: '3', marketplace_profiles: { selling_cost: 'Low' } },
    ]

    const groups = groupRows(embedded, 'marketplace_profiles.selling_cost')
    expect(groups.map((group) => group.key)).toEqual(['High', 'Low'])
    expect(groups.find((group) => group.key === 'Low')?.rows).toHaveLength(2)
  })

  /*
   * A path that runs out part way is "no value", not a crash. Grouping keys
   * arrive from the URL, and a row that simply has no profile — or a key naming
   * something that was never there — has to land in the empty bucket.
   */
  it('treats a path that does not resolve as no value', () => {
    const partial = [{ id: '1' }, { id: '2', marketplace_profiles: null }]

    const groups = groupRows(partial, 'marketplace_profiles.selling_cost')
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBeNull()
    expect(groups[0].rows).toHaveLength(2)
  })

  it('sorts the ungrouped bucket last', () => {
    const groups = groupRows(rows, 'source')
    expect(groups.at(-1)?.key).toBeNull()
  })
})

describe('grouping by a field that holds several values', () => {
  /*
   * Tag ids, as the lists carry them: the group key is the id and the heading
   * comes from the field's options, so renaming a tag moves no record.
   */
  const rows = [
    { id: '1', tags: ['vip', 'canada'] },
    { id: '2', tags: ['vip'] },
    { id: '3', tags: [] },
    { id: '4', tags: ['canada'] },
  ]

  it('puts a row in every group it belongs to', () => {
    const groups = groupRows(rows, TAGS_FIELD_KEY)

    expect(groups.map((group) => group.key)).toEqual(['canada', 'vip', null])
    expect(groups.find((group) => group.key === 'vip')?.rows.map((row) => row.id)).toEqual([
      '1',
      '2',
    ])
    expect(groups.find((group) => group.key === 'canada')?.rows.map((row) => row.id)).toEqual([
      '1',
      '4',
    ])
  })

  it('counts a doubly tagged row once per group, so the groups outnumber the rows', () => {
    const groups = groupRows(rows, TAGS_FIELD_KEY)
    const counted = groups.reduce((total, group) => total + group.rows.length, 0)

    expect(counted).toBe(5)
    expect(counted).toBeGreaterThan(rows.length)
  })

  it('sends an untagged row to the empty bucket rather than a bucket of its own', () => {
    const groups = groupRows(rows, TAGS_FIELD_KEY)
    const untagged = groups.find((group) => group.key === null)

    expect(untagged?.rows.map((row) => row.id)).toEqual(['3'])
    expect(groups.at(-1)?.key).toBeNull()
  })

  it('does not repeat a row that carries the same value twice', () => {
    const groups = groupRows([{ id: '1', tags: ['vip', 'vip'] }], TAGS_FIELD_KEY)

    expect(groups).toHaveLength(1)
    expect(groups[0].rows).toHaveLength(1)
  })

  it('ignores blanks inside the list', () => {
    const groups = groupRows([{ id: '1', tags: ['vip', '', null] }], TAGS_FIELD_KEY)

    expect(groups.map((group) => group.key)).toEqual(['vip'])
  })

  it('reads tag headings off the field options', () => {
    const fields = [{ ...TAGS_FIELD, options: [{ value: 'vip', label: 'VIP' }] }]

    expect(labelFromFields(fields)(TAGS_FIELD_KEY, 'vip')).toBe('VIP')
    expect(labelFromFields(fields)(TAGS_FIELD_KEY, null)).toBe('None')
  })

  it('still groups a single-valued field into one bucket each', () => {
    const groups = groupRows(
      [
        { id: '1', source: 'website' },
        { id: '2', source: 'website' },
      ],
      'source',
    )

    expect(groups).toHaveLength(1)
    expect(groups[0].rows).toHaveLength(2)
  })

  it('sub-groups the repeated row inside each group it landed in', () => {
    const nested = groupRowsNested(
      [
        { id: '1', tags: ['vip', 'canada'], priority: 'high' },
        { id: '2', tags: ['vip'], priority: 'low' },
      ],
      TAGS_FIELD_KEY,
      'priority',
    )

    const vip = nested.find((group) => group.key === 'vip')
    expect(vip?.subGroups?.map((group) => group.key)).toEqual(['high', 'low'])
    expect(nested.find((group) => group.key === 'canada')?.subGroups).toHaveLength(1)
  })
})

describe('overlappingGroupField', () => {
  const fields = [
    TAGS_FIELD,
    { key: 'priority', label: 'Priority', type: 'enum' as const, groupable: true },
  ]

  it('names the field when the top level holds several values', () => {
    expect(overlappingGroupField(fields, TAGS_FIELD_KEY, null)?.label).toBe('Tags')
  })

  it('names it when only the sub-group does', () => {
    expect(overlappingGroupField(fields, 'priority', TAGS_FIELD_KEY)?.label).toBe('Tags')
  })

  it('prefers the top level, which is the one being added up', () => {
    expect(overlappingGroupField(fields, TAGS_FIELD_KEY, 'priority')?.label).toBe('Tags')
  })

  it('says nothing when neither level repeats a row', () => {
    expect(overlappingGroupField(fields, 'priority', null)).toBeNull()
  })

  it('says nothing when there is no grouping at all', () => {
    expect(overlappingGroupField(fields, null, TAGS_FIELD_KEY)).toBeNull()
  })
})

describe('groupRowsNested', () => {
  const rows = [
    { id: '1', owner: 'ada', priority: 'high', custom_fields: {} },
    { id: '2', owner: 'ada', priority: 'low', custom_fields: {} },
    { id: '3', owner: 'ada', priority: 'high', custom_fields: {} },
    { id: '4', owner: 'raj', priority: null, custom_fields: {} },
  ]

  it('splits each group by the second field', () => {
    const groups = groupRowsNested(rows, 'owner', 'priority')

    expect(groups.map((group) => group.key)).toEqual(['ada', 'raj'])

    const ada = groups[0]
    expect(ada.rows).toHaveLength(3)
    expect(ada.subGroups?.map((sub) => sub.key)).toEqual(['high', 'low'])
    expect(ada.subGroups?.[0].rows).toHaveLength(2)
  })

  it('carries the ungrouped bucket into the second level too', () => {
    const groups = groupRowsNested(rows, 'owner', 'priority')
    expect(groups[1].subGroups?.[0].key).toBeNull()
  })

  it('leaves subGroups off when only one level was asked for', () => {
    expect(groupRowsNested(rows, 'owner', null)[0].subGroups).toBeUndefined()
  })

  /*
   * The same field twice would give every group one sub-group holding exactly
   * itself — a heading repeating the heading above it.
   */
  it('treats the same field on both levels as one level', () => {
    expect(groupRowsNested(rows, 'owner', 'owner')[0].subGroups).toBeUndefined()
  })

  it('labels each level with its own field', () => {
    const groups = groupRowsNested(rows, 'owner', 'priority', (field, value) =>
      value === null ? 'None' : `${field}=${value}`,
    )

    expect(groups[0].label).toBe('owner=ada')
    expect(groups[0].subGroups?.[0].label).toBe('priority=high')
  })

  it('does nothing with a sub-group and no group', () => {
    const groups = groupRowsNested(rows, null, 'priority')
    expect(groups).toHaveLength(1)
    expect(groups[0].subGroups).toBeUndefined()
  })
})

describe('saved filter round-tripping', () => {
  it('survives a trip through the URL', () => {
    const config: FilterConfig = {
      match: 'any',
      conditions: [
        { field: 'lifecycle_stage', operator: 'eq', value: 'lead' },
        { field: 'custom_fields.tier', operator: 'contains', value: 'gold' },
      ],
      search: 'acme',
      groupBy: 'owner_id',
      subGroupBy: 'lifecycle_stage',
      sort: { field: 'lead_score', direction: 'asc' },
    }

    const params = filterToSearchParams(config)
    const restored = filterFromSearchParams(Object.fromEntries(params.entries()))

    expect(restored).toEqual(config)
  })

  it('drops a sub-group with no group to sit inside', () => {
    const params = filterToSearchParams({
      ...EMPTY_FILTER,
      groupBy: null,
      subGroupBy: 'priority',
    })

    expect(params.has('subgroup')).toBe(false)
    // And a hand-written URL claiming one is not honoured either, so a bookmark
    // cannot resurrect a level with nothing above it.
    expect(filterFromSearchParams({ subgroup: 'priority' }).subGroupBy).toBeNull()
  })

  it('parses a stored filter, ignoring malformed conditions', () => {
    const parsed = parseFilterConfig({
      match: 'any',
      conditions: [{ field: 'source', operator: 'eq', value: 'website' }, { nonsense: true }, null],
      groupBy: 'source',
    })

    expect(parsed.conditions).toHaveLength(1)
    expect(parsed.match).toBe('any')
    expect(parsed.groupBy).toBe('source')
  })

  it('falls back to an empty filter for junk input', () => {
    expect(parseFilterConfig(null).conditions).toEqual([])
    expect(parseFilterConfig('nope').match).toBe('all')
  })

  it('ignores an unparseable condition list in the URL', () => {
    expect(filterFromSearchParams({ f: '{not json' }).conditions).toEqual([])
  })
})

describe('dealVisibility', () => {
  const closing = ['won-stage', 'lost-stage']

  it('keeps a card on the board after it is dropped into Won', () => {
    // The regression this exists for: once dragging into Won marked the deal
    // won, the default filter swept the card off the board and the drop looked
    // like a delete.
    expect(dealVisibility('open', 'kanban', closing)).toEqual({
      kind: 'open-or-closing',
      closingStageIds: closing,
    })
  })

  it('means open deals and nothing else on the list', () => {
    // A list is not arranged by stage, so there is no empty column to explain.
    expect(dealVisibility('open', 'list', closing)).toEqual({ kind: 'status', status: 'open' })
  })

  it('falls back to a plain filter when no stage closes anything', () => {
    expect(dealVisibility('open', 'kanban', [])).toEqual({ kind: 'status', status: 'open' })
  })

  it('answers a deliberate choice literally, on either view', () => {
    expect(dealVisibility('won', 'kanban', closing)).toEqual({ kind: 'status', status: 'won' })
    expect(dealVisibility('lost', 'list', closing)).toEqual({ kind: 'status', status: 'lost' })
  })

  it('applies nothing at all for "open and closed"', () => {
    expect(dealVisibility('all', 'kanban', closing)).toEqual({ kind: 'all' })
    expect(dealVisibility('all', 'list', closing)).toEqual({ kind: 'all' })
  })
})

/*
 * The in-memory path, used by the marketplaces list because half its fields
 * live on an embedded profile. Every expectation here is really an assertion
 * that it agrees with the query path — the same FilterBar drives both.
 */
describe('matchesFilter', () => {
  const row = {
    name: 'Liquidation Central',
    domain: 'liq.example',
    priority: 'High',
    owner_id: 'ada',
    sells_in: ['CA', 'US'],
    marketplace_profiles: {
      selling_cost: 'Low',
      payment: 'Via Platform',
      buyers_premium: true,
      audience: ['B2B'],
      store_name: 'Central Outlet',
      reserve_percent: 12,
      opened_on: '2025-04-01',
    },
  }

  const filter = (...conditions: FilterConfig['conditions']): FilterConfig => ({
    ...EMPTY_FILTER,
    conditions,
  })

  it('matches a condition on an embedded field', () => {
    const yes = filter({ field: 'marketplace_profiles.selling_cost', operator: 'eq', value: 'Low' })
    const no = filter({ field: 'marketplace_profiles.selling_cost', operator: 'eq', value: 'High' })

    expect(matchesFilter(row, yes, 'marketplace')).toBe(true)
    expect(matchesFilter(row, no, 'marketplace')).toBe(false)
  })

  it('requires every condition under match: all', () => {
    const config = filter(
      { field: 'priority', operator: 'eq', value: 'High' },
      { field: 'marketplace_profiles.payment', operator: 'eq', value: 'Via Seller' },
    )

    expect(matchesFilter(row, config, 'marketplace')).toBe(false)
    expect(matchesFilter(row, { ...config, match: 'any' }, 'marketplace')).toBe(true)
  })

  it('handles the array operators against a stored array', () => {
    const has = (operator: 'has_all' | 'has_any' | 'has_none', value: string) =>
      matchesFilter(row, filter({ field: 'sells_in', operator, value }), 'marketplace')

    expect(has('has_all', 'CA,US')).toBe(true)
    expect(has('has_all', 'CA,MX')).toBe(false)
    expect(has('has_any', 'MX,US')).toBe(true)
    expect(has('has_none', 'MX')).toBe(true)
    expect(has('has_none', 'US')).toBe(false)
  })

  /* The stored array is sorted by a trigger; what somebody types is not. */
  it('compares is_exactly as a set rather than in order', () => {
    const exactly = (value: string) =>
      matchesFilter(row, filter({ field: 'sells_in', operator: 'is_exactly', value }), 'marketplace')

    expect(exactly('US,CA')).toBe(true)
    expect(exactly('CA')).toBe(false)
  })

  it('compares numbers numerically and dates lexicographically', () => {
    const cond = (field: string, operator: 'gt' | 'lt', value: string) =>
      matchesFilter(row, filter({ field, operator, value }), 'marketplace')

    // 9 < 12 numerically, which string comparison would get backwards.
    expect(cond('marketplace_profiles.reserve_percent', 'gt', '9')).toBe(true)
    expect(cond('marketplace_profiles.reserve_percent', 'lt', '9')).toBe(false)
    expect(cond('marketplace_profiles.opened_on', 'gt', '2025-01-01')).toBe(true)
    expect(cond('marketplace_profiles.opened_on', 'lt', '2025-01-01')).toBe(false)
  })

  /*
   * `col <> 'x'` is null for a null column, and null is not true. The query
   * path drops those rows, so this one has to as well.
   */
  it('does not match is-not against a row with no value', () => {
    const bare = { name: 'Nothing recorded', marketplace_profiles: {} }
    const config = filter({
      field: 'marketplace_profiles.selling_cost',
      operator: 'neq',
      value: 'Low',
    })

    expect(matchesFilter(bare, config, 'marketplace')).toBe(false)
  })

  it('answers is_empty and is_not_empty for a missing embedded field', () => {
    const bare = { name: 'Nothing recorded', marketplace_profiles: {} }
    const empty = filter({ field: 'marketplace_profiles.selling_cost', operator: 'is_empty', value: '' })

    expect(matchesFilter(bare, empty, 'marketplace')).toBe(true)
    expect(matchesFilter(row, empty, 'marketplace')).toBe(false)
  })

  /* A condition somebody has added but not filled in narrows nothing. */
  it('skips a condition with no value', () => {
    const config = filter({ field: 'priority', operator: 'eq', value: '' })
    expect(matchesFilter(row, config, 'marketplace')).toBe(true)
  })

  it('searches the entity’s own columns, embedded ones included', () => {
    const search = (term: string) =>
      matchesFilter(row, { ...EMPTY_FILTER, search: term }, 'marketplace')

    expect(search('liquidation')).toBe(true)
    expect(search('central outlet')).toBe(true)
    expect(search('nowhere')).toBe(false)
  })

  it('applies the search on top of the conditions rather than instead of them', () => {
    const config = {
      ...filter({ field: 'priority', operator: 'eq', value: 'High' }),
      search: 'nowhere',
    }
    expect(matchesFilter(row, config, 'marketplace')).toBe(false)
  })
})

describe('sortRows', () => {
  const rows = [
    { id: 'a', name: 'Beta', profile: { cost: 3 } },
    { id: 'b', name: 'alpha', profile: { cost: 1 } },
    { id: 'c', name: 'Gamma', profile: {} },
  ]

  it('leaves the order alone when nothing was chosen', () => {
    expect(sortRows(rows, null).map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts by an embedded field, numerically', () => {
    const sorted = sortRows(rows, { field: 'profile.cost', direction: 'asc' })
    expect(sorted.map((row) => row.id)).toEqual(['b', 'a', 'c'])
  })

  /* Blanks last in both directions, matching `nullsFirst: false` on the query. */
  it('puts rows with no value last whichever way it is sorted', () => {
    expect(sortRows(rows, { field: 'profile.cost', direction: 'desc' }).at(-1)?.id).toBe('c')
    expect(sortRows(rows, { field: 'profile.cost', direction: 'asc' }).at(-1)?.id).toBe('c')
  })

  it('does not mutate the array it was given', () => {
    const original = [...rows]
    sortRows(rows, { field: 'name', direction: 'asc' })
    expect(rows).toEqual(original)
  })
})

/*
 * The defect this exists for: a list grouped by lifecycle stage whose headings
 * read "lead" and "qualified", and one grouped by owner whose headings are
 * uuids. Both fields already carried the mapping for the filter's sake.
 */
describe('labelFromFields', () => {
  const label = labelFromFields([
    {
      key: 'lifecycle_stage',
      label: 'Lifecycle stage',
      type: 'enum',
      options: [
        { value: 'lead', label: 'Lead' },
        { value: 'customer', label: 'Customer' },
      ],
    },
    {
      key: 'owner_id',
      label: 'Owner',
      type: 'uuid',
      options: [{ value: 'u-1', label: 'Ada Lovelace' }],
    },
    { key: 'source', label: 'Source', type: 'text' },
  ])

  it('reads a stored enum value as its label', () => {
    expect(label('lifecycle_stage', 'lead')).toBe('Lead')
    expect(label('lifecycle_stage', 'customer')).toBe('Customer')
  })

  it('reads an id as the name the filter offers for it', () => {
    expect(label('owner_id', 'u-1')).toBe('Ada Lovelace')
  })

  it('calls the empty bucket None', () => {
    expect(label('lifecycle_stage', null)).toBe('None')
    expect(label('source', null)).toBe('None')
  })

  /* A field with nothing to map passes its value straight through. */
  it('leaves a plain value alone', () => {
    expect(label('source', 'trade show')).toBe('trade show')
  })

  /*
   * An unresolved uuid says nothing to a reader, so it becomes a word. Anything
   * else reads better as itself: present-but-unrecognised should look slightly
   * wrong rather than absent.
   */
  it('names an unresolved id but keeps an unresolved value', () => {
    expect(label('owner_id', 'u-gone')).toBe('Unknown')
    expect(label('lifecycle_stage', 'archived')).toBe('archived')
  })

  it('ignores a field whose option list is empty', () => {
    const bare = labelFromFields([{ key: 'status', label: 'Status', type: 'enum', options: [] }])
    expect(bare('status', 'draft')).toBe('draft')
  })
})
