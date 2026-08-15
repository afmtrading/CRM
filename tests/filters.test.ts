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
  parseFilterConfig,
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

  it('sorts the ungrouped bucket last', () => {
    const groups = groupRows(rows, 'source')
    expect(groups.at(-1)?.key).toBeNull()
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
