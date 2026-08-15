'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'

import {
  OPERATOR_LABELS,
  filterToSearchParams,
  operatorsFor,
  parseFilterConfig,
  type FieldDef,
  type FilterCondition,
  type FilterConfig,
} from '@/lib/filters'
import type { SavedFilterRow } from '@/lib/database.types'
import { ExportIcon, FilterIcon, SearchIcon } from '@/components/icons'

/**
 * The filter / group / save UI behind PRD 6.6. It owns no data: it edits a
 * FilterConfig, pushes it into the URL, and lets the server component re-query.
 * That is what makes a filtered view shareable and a saved filter replayable.
 */
export function FilterBar({
  fields,
  initial,
  savedFilters,
  entityType,
  currentUserId,
  canExport = true,
  saveAction,
  deleteAction,
}: {
  fields: FieldDef[]
  initial: FilterConfig
  savedFilters: SavedFilterRow[]
  entityType: 'contact' | 'company' | 'deal'
  currentUserId: string
  /** Export can pull the whole book, so it is a manager's action. */
  canExport?: boolean
  saveAction: (formData: FormData) => void
  deleteAction: (formData: FormData) => void
}) {
  const router = useRouter()
  const pathname = usePathname()

  const [config, setConfig] = useState<FilterConfig>(initial)
  const [open, setOpen] = useState(initial.conditions.length > 0)
  const [saving, setSaving] = useState(false)

  const groupable = fields.filter((field) => field.groupable)
  const sortable = fields.filter((field) => field.sortable)

  function apply(next: FilterConfig) {
    setConfig(next)
    const params = filterToSearchParams(next)
    router.push(`${pathname}?${params.toString()}`)
  }

  function updateCondition(index: number, patch: Partial<FilterCondition>) {
    const conditions = config.conditions.map((condition, i) =>
      i === index ? { ...condition, ...patch } : condition,
    )
    setConfig({ ...config, conditions })
  }

  function fieldDef(key: string) {
    return fields.find((field) => field.key === key) ?? fields[0]
  }

  const exportParams = filterToSearchParams(config)
  exportParams.set('entity', entityType)

  return (
    <div className="card mb-5">
      <div className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative max-w-xs flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            placeholder="Search…"
            className="input pl-9"
            value={config.search ?? ''}
            onChange={(event) => setConfig({ ...config, search: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') apply(config)
            }}
          />
        </div>

        <button type="button" className="btn-secondary" onClick={() => setOpen(!open)}>
          <FilterIcon className="h-4 w-4" />
          Filters
          {config.conditions.length > 0 && (
            <span className="badge bg-brand-100 px-1.5 text-brand-700">{config.conditions.length}</span>
          )}
        </button>

        <select
          className="input max-w-40"
          value={config.groupBy ?? ''}
          onChange={(event) =>
            apply({
              ...config,
              groupBy: event.target.value || null,
              // Dropping the group drops what was nested inside it, and
              // choosing the same field for both is one level, so the second
              // is cleared rather than left to be silently ignored.
              subGroupBy:
                !event.target.value || event.target.value === config.subGroupBy
                  ? null
                  : config.subGroupBy,
            })
          }
        >
          <option value="">No grouping</option>
          {groupable.map((field) => (
            <option key={field.key} value={field.key}>
              Group by {field.label.toLowerCase()}
            </option>
          ))}
        </select>

        {/* Only once there is something to nest inside. */}
        {config.groupBy && (
          <select
            className="input max-w-40"
            value={config.subGroupBy ?? ''}
            aria-label="Then group by"
            onChange={(event) => apply({ ...config, subGroupBy: event.target.value || null })}
          >
            <option value="">No sub-group</option>
            {groupable
              .filter((field) => field.key !== config.groupBy)
              .map((field) => (
                <option key={field.key} value={field.key}>
                  Then by {field.label.toLowerCase()}
                </option>
              ))}
          </select>
        )}

        <select
          className="input max-w-44"
          value={config.sort ? `${config.sort.field}:${config.sort.direction}` : ''}
          onChange={(event) => {
            const [field, direction] = event.target.value.split(':')
            apply({
              ...config,
              sort: field ? { field, direction: direction === 'asc' ? 'asc' : 'desc' } : null,
            })
          }}
        >
          <option value="">Newest first</option>
          {sortable.flatMap((field) => [
            <option key={`${field.key}:asc`} value={`${field.key}:asc`}>
              {field.label} ↑
            </option>,
            <option key={`${field.key}:desc`} value={`${field.key}:desc`}>
              {field.label} ↓
            </option>,
          ])}
        </select>

        <button type="button" className="btn-primary" onClick={() => apply(config)}>
          Apply
        </button>

        <div className="ml-auto flex items-center gap-2">
          {canExport && (
            <Link
              className="btn-secondary"
              href={`/api/export?${exportParams.toString()}`}
              prefetch={false}
            >
              <ExportIcon className="h-4 w-4" />
              Export CSV
            </Link>
          )}
          <button type="button" className="btn-secondary" onClick={() => setSaving(!saving)}>
            Save view
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-2 border-t border-slate-100 p-3">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            Match
            <select
              className="input max-w-24"
              value={config.match}
              onChange={(event) =>
                setConfig({ ...config, match: event.target.value === 'any' ? 'any' : 'all' })
              }
            >
              <option value="all">all</option>
              <option value="any">any</option>
            </select>
            of the following
          </div>

          {config.conditions.map((condition, index) => {
            const def = fieldDef(condition.field)
            const operators = operatorsFor(def.type)
            const needsValue = !['is_empty', 'is_not_empty'].includes(condition.operator)

            return (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <select
                  className="input max-w-48"
                  value={condition.field}
                  onChange={(event) => {
                    const nextDef = fieldDef(event.target.value)
                    updateCondition(index, {
                      field: event.target.value,
                      operator: operatorsFor(nextDef.type)[0],
                      value: '',
                    })
                  }}
                >
                  {fields.map((field) => (
                    <option key={field.key} value={field.key}>
                      {field.label}
                    </option>
                  ))}
                </select>

                <select
                  className="input max-w-40"
                  value={condition.operator}
                  onChange={(event) =>
                    updateCondition(index, {
                      operator: event.target.value as FilterCondition['operator'],
                    })
                  }
                >
                  {operators.map((operator) => (
                    <option key={operator} value={operator}>
                      {OPERATOR_LABELS[operator]}
                    </option>
                  ))}
                </select>

                {needsValue &&
                  (def.options ? (
                    <select
                      className="input max-w-56"
                      value={String(condition.value ?? '')}
                      onChange={(event) => updateCondition(index, { value: event.target.value })}
                    >
                      <option value="">Select…</option>
                      {def.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="input max-w-56"
                      type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
                      value={String(condition.value ?? '')}
                      onChange={(event) => updateCondition(index, { value: event.target.value })}
                      placeholder="Value"
                    />
                  ))}

                <button
                  type="button"
                  className="text-sm text-slate-400 hover:text-red-600"
                  onClick={() =>
                    setConfig({
                      ...config,
                      conditions: config.conditions.filter((_, i) => i !== index),
                    })
                  }
                  aria-label="Remove condition"
                >
                  ✕
                </button>
              </div>
            )
          })}

          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                setConfig({
                  ...config,
                  conditions: [
                    ...config.conditions,
                    { field: fields[0].key, operator: operatorsFor(fields[0].type)[0], value: '' },
                  ],
                })
              }
            >
              + Add condition
            </button>
            {config.conditions.length > 0 && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => apply({ ...config, conditions: [] })}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {saving && (
        <form action={saveAction} className="flex flex-wrap items-end gap-2 border-t border-slate-100 p-3">
          <input type="hidden" name="entity_type" value={entityType} />
          <input type="hidden" name="filter_json" value={JSON.stringify(config)} />
          <div>
            <label className="label" htmlFor="filter-name">
              View name
            </label>
            <input id="filter-name" name="name" required className="input w-64" placeholder="Hot leads" />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-600">
            <input type="checkbox" name="is_shared" className="rounded border-slate-300" />
            Share with the whole organization
          </label>
          <button type="submit" className="btn-primary mb-0.5">
            Save
          </button>
        </form>
      )}

      {savedFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-3">
          <span className="text-xs font-medium tracking-wide text-slate-400 uppercase">Saved views</span>
          {savedFilters.map((filter) => {
            // Parsed rather than trusted: a saved view is stored JSON, and a
            // malformed one must not take the whole list page down.
            const params = filterToSearchParams(parseFilterConfig(filter.filter_json))
            params.set('view', filter.id)
            return (
              <span
                key={filter.id}
                className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pr-1 pl-2.5 text-xs"
              >
                <Link href={`${pathname}?${params.toString()}`} className="text-slate-700 hover:text-brand-700">
                  {filter.name}
                  {filter.is_shared && <span className="ml-1 text-slate-400">· shared</span>}
                </Link>
                {(filter.user_id === currentUserId || filter.is_shared) && (
                  <form action={deleteAction} className="inline">
                    <input type="hidden" name="id" value={filter.id} />
                    <input type="hidden" name="return_to" value={pathname} />
                    <button
                      type="submit"
                      className="px-1 text-slate-300 hover:text-red-600"
                      aria-label={`Delete saved view ${filter.name}`}
                    >
                      ✕
                    </button>
                  </form>
                )}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
