/**
 * Bulk import and export (PRD 6.7).
 *
 * Row mapping and validation are pure functions so the preview step and the
 * commit step run *the same* code: what the preview shows is exactly what gets
 * written.
 */

import type { FilterEntityType, LifecycleStage } from '@/lib/database.types'

export interface ImportFieldSpec {
  key: string
  label: string
  required?: boolean
  type?: 'text' | 'email' | 'number' | 'enum'
  options?: string[]
}

export const CONTACT_IMPORT_FIELDS: ImportFieldSpec[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone' },
  { key: 'company_name', label: 'Company (by name)' },
  {
    key: 'lifecycle_stage',
    label: 'Lifecycle stage',
    type: 'enum',
    options: ['lead', 'qualified', 'customer', 'other'],
  },
  { key: 'source', label: 'Source' },
  { key: 'tags', label: 'Tags (comma separated)' },
]

export const COMPANY_IMPORT_FIELDS: ImportFieldSpec[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'domain', label: 'Domain' },
  { key: 'industry', label: 'Industry' },
]

export function importFieldsFor(entity: FilterEntityType): ImportFieldSpec[] {
  return entity === 'company' ? COMPANY_IMPORT_FIELDS : CONTACT_IMPORT_FIELDS
}

/** Maps a source CSV column name to a system field key (or a custom field). */
export type FieldMapping = Record<string, string>

export interface MappedRow {
  rowNumber: number
  values: Record<string, string>
  customFields: Record<string, string>
  errors: string[]
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Guesses a mapping from CSV headers, so the mapping step starts mostly filled
 * in rather than empty.
 */
export function suggestMapping(headers: string[], fields: ImportFieldSpec[]): FieldMapping {
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const mapping: FieldMapping = {}

  for (const header of headers) {
    const normalised = normalise(header)
    const match = fields.find(
      (field) => normalise(field.key) === normalised || normalise(field.label) === normalised,
    )
    if (match) {
      mapping[header] = match.key
      continue
    }
    // Common alternative spellings.
    const aliases: Record<string, string> = {
      firstname: 'first_name',
      givenname: 'first_name',
      lastname: 'last_name',
      surname: 'last_name',
      familyname: 'last_name',
      emailaddress: 'email',
      mail: 'email',
      phonenumber: 'phone',
      mobile: 'phone',
      telephone: 'phone',
      tel: 'phone',
      company: 'company_name',
      account: 'company_name',
      organisation: 'company_name',
      organization: 'company_name',
      website: 'domain',
      stage: 'lifecycle_stage',
      lifecycle: 'lifecycle_stage',
      leadsource: 'source',
    }
    if (aliases[normalised] && fields.some((f) => f.key === aliases[normalised])) {
      mapping[header] = aliases[normalised]
    }
  }

  return mapping
}

/**
 * Applies a mapping to one raw CSV row and validates it. Never throws: a bad
 * row comes back with `errors` populated so the batch can continue and the job
 * can report which rows failed and why (acceptance criterion 6.7).
 */
export function mapRow(
  raw: Record<string, string>,
  mapping: FieldMapping,
  fields: ImportFieldSpec[],
  rowNumber: number,
): MappedRow {
  const values: Record<string, string> = {}
  const customFields: Record<string, string> = {}
  const errors: string[] = []

  for (const [header, target] of Object.entries(mapping)) {
    if (!target || target === '__skip__') continue

    const value = (raw[header] ?? '').trim()
    if (target.startsWith('custom_fields.')) {
      if (value) customFields[target.slice('custom_fields.'.length)] = value
      continue
    }
    if (value) values[target] = value
  }

  for (const field of fields) {
    const value = values[field.key]

    if (field.required && !value) {
      errors.push(`${field.label} is required`)
      continue
    }
    if (!value) continue

    if (field.type === 'email' && !EMAIL_RE.test(value)) {
      errors.push(`${field.label} "${value}" is not a valid email address`)
    }
    if (field.type === 'number' && Number.isNaN(Number(value))) {
      errors.push(`${field.label} "${value}" is not a number`)
    }
    if (field.type === 'enum' && field.options && !field.options.includes(value.toLowerCase())) {
      errors.push(`${field.label} "${value}" must be one of: ${field.options.join(', ')}`)
    }
  }

  // A contact needs at least something to identify it by.
  if (fields === CONTACT_IMPORT_FIELDS || fields.some((f) => f.key === 'first_name')) {
    if (!values.first_name && !values.last_name && !values.email) {
      errors.push('Row needs at least a first name, last name, or email address')
    }
  }

  return { rowNumber, values, customFields, errors }
}

export interface ContactImportPayload {
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  lifecycle_stage: LifecycleStage
  source: string | null
  custom_fields: Record<string, string>
  company_name?: string
  tags: string[]
}

export function toContactPayload(row: MappedRow): ContactImportPayload {
  const stage = (row.values.lifecycle_stage ?? '').toLowerCase()
  const validStages: LifecycleStage[] = ['lead', 'qualified', 'customer', 'other']

  return {
    first_name: row.values.first_name ?? '',
    last_name: row.values.last_name ?? '',
    email: row.values.email ? row.values.email.toLowerCase() : null,
    phone: row.values.phone ?? null,
    lifecycle_stage: validStages.includes(stage as LifecycleStage) ? (stage as LifecycleStage) : 'lead',
    source: row.values.source ?? null,
    custom_fields: row.customFields,
    company_name: row.values.company_name,
    tags: (row.values.tags ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  }
}

/**
 * CSV serialisation for the export side. Deliberately dependency-free and
 * complete: PRD Section 10 requires an export to be sufficient to reconstruct
 * an organization's data.
 */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return columns?.join(',') ?? ''

  const headers = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))]

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    const raw = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
  }

  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
  ]

  return lines.join('\n')
}
