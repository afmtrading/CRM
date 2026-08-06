'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import Papa from 'papaparse'

import { importFieldsFor, mapRow, suggestMapping, type FieldMapping } from '@/lib/csv'
import type { CustomFieldDefinitionRow, ImportJobRow } from '@/lib/database.types'

type Entity = 'contact' | 'company'
type Step = 'upload' | 'map' | 'result'

/**
 * CSV import with field mapping and a preview step before committing (6.7).
 *
 * Parsing and validation happen in the browser using the same pure functions
 * the server re-runs on commit, so the preview is not an approximation — the
 * rows flagged here are exactly the rows the server will reject.
 */
export function ImportWizard({ customFields }: { customFields: CustomFieldDefinitionRow[] }) {
  const [entity, setEntity] = useState<Entity>('contact')
  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [mapping, setMapping] = useState<FieldMapping>({})
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'update' | 'create'>('skip')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<ImportJobRow | null>(null)

  const targetFields = useMemo(() => {
    const base = importFieldsFor(entity).map((field) => ({ key: field.key, label: field.label }))
    const custom = customFields
      .filter((definition) => definition.entity_type === entity)
      .map((definition) => ({
        key: `custom_fields.${definition.key}`,
        label: `${definition.label} (custom)`,
      }))
    return [...base, ...custom]
  }, [entity, customFields])

  const preview = useMemo(() => {
    const fields = importFieldsFor(entity)
    return rows.slice(0, 10).map((row, index) => mapRow(row, mapping, fields, index + 2))
  }, [rows, mapping, entity])

  const allChecked = useMemo(() => {
    const fields = importFieldsFor(entity)
    return rows.map((row, index) => mapRow(row, mapping, fields, index + 2))
  }, [rows, mapping, entity])

  const invalidCount = allChecked.filter((row) => row.errors.length > 0).length

  function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setError(null)
    setFileName(file.name)

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const parsedHeaders = results.meta.fields ?? []
        if (parsedHeaders.length === 0) {
          setError('That file has no header row.')
          return
        }
        setHeaders(parsedHeaders)
        setRows(results.data)
        setMapping(suggestMapping(parsedHeaders, importFieldsFor(entity)))
        setStep('map')
      },
      error: (parseError) => setError(parseError.message),
    })
  }

  async function commit() {
    setPending(true)
    setError(null)

    try {
      const response = await fetch('/api/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entity_type: entity,
          file_name: fileName,
          mapping,
          rows,
          options: { on_duplicate: onDuplicate, create_missing_companies: true },
        }),
      })

      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? 'Import failed')

      setJob(payload.job as ImportJobRow)
      setStep('result')
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Import failed')
    } finally {
      setPending(false)
    }
  }

  function reset() {
    setStep('upload')
    setRows([])
    setHeaders([])
    setMapping({})
    setJob(null)
    setFileName('')
    setError(null)
  }

  if (step === 'result' && job) {
    const jobErrors = (job.errors ?? []) as { row: number; errors: string[] }[]

    return (
      <div className="space-y-4">
        <div className="card p-5">
          <h2 className="text-base font-semibold text-slate-900">Import complete</h2>
          <p className="mt-1 text-sm text-slate-600">
            <span className="font-medium text-emerald-700">{job.rows_processed} imported</span>
            {job.rows_failed > 0 && (
              <>
                {' · '}
                <span className="font-medium text-red-700">{job.rows_failed} not imported</span>
              </>
            )}{' '}
            from {job.file_name}
          </p>

          <div className="mt-4 flex gap-2">
            <Link href={entity === 'contact' ? '/contacts' : '/companies'} className="btn-primary">
              View {entity === 'contact' ? 'contacts' : 'companies'}
            </Link>
            <button type="button" className="btn-secondary" onClick={reset}>
              Import another file
            </button>
          </div>
        </div>

        {jobErrors.length > 0 && (
          <div className="card overflow-hidden">
            <header className="border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-800">Rows that did not import</h3>
            </header>
            <table className="table">
              <thead>
                <tr>
                  <th className="w-24">CSV row</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {jobErrors.map((rowError) => (
                  <tr key={rowError.row}>
                    <td className="text-slate-500">{rowError.row}</td>
                    <td className="text-red-700">{rowError.errors.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="card space-y-4 p-5">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="label" htmlFor="import-entity">
              Import into
            </label>
            <select
              id="import-entity"
              className="input w-44"
              value={entity}
              onChange={(event) => {
                setEntity(event.target.value as Entity)
                if (headers.length > 0) {
                  setMapping(suggestMapping(headers, importFieldsFor(event.target.value as Entity)))
                }
              }}
            >
              <option value="contact">Contacts</option>
              <option value="company">Companies</option>
            </select>
          </div>

          <div>
            <label className="label" htmlFor="import-file">
              CSV file
            </label>
            <input
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              className="block text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-200"
            />
          </div>

          {entity === 'contact' && (
            <div>
              <label className="label" htmlFor="import-duplicates">
                When a contact already exists
              </label>
              <select
                id="import-duplicates"
                className="input w-56"
                value={onDuplicate}
                onChange={(event) => setOnDuplicate(event.target.value as typeof onDuplicate)}
              >
                <option value="skip">Skip the row</option>
                <option value="update">Update the existing contact</option>
                <option value="create">Create a second record</option>
              </select>
            </div>
          )}
        </div>

        {step === 'upload' && (
          <p className="text-sm text-slate-500">
            The first row must be a header row. Nothing is written until you confirm the preview.
          </p>
        )}
      </div>

      {step === 'map' && (
        <>
          <div className="card overflow-hidden">
            <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-800">Map the columns</h2>
              <span className="text-xs text-slate-500">
                {rows.length} row{rows.length === 1 ? '' : 's'} in {fileName}
              </span>
            </header>
            <table className="table">
              <thead>
                <tr>
                  <th>CSV column</th>
                  <th>Sample value</th>
                  <th className="w-64">Imports to</th>
                </tr>
              </thead>
              <tbody>
                {headers.map((header) => (
                  <tr key={header}>
                    <td className="font-medium text-slate-800">{header}</td>
                    <td className="max-w-xs truncate text-slate-500">{rows[0]?.[header] ?? ''}</td>
                    <td>
                      <select
                        className="input"
                        value={mapping[header] ?? '__skip__'}
                        onChange={(event) =>
                          setMapping({ ...mapping, [header]: event.target.value })
                        }
                        aria-label={`Map ${header}`}
                      >
                        <option value="__skip__">— Do not import —</option>
                        {targetFields.map((field) => (
                          <option key={field.key} value={field.key}>
                            {field.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card overflow-hidden">
            <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-800">Preview</h2>
              <span className="text-xs text-slate-500">
                {invalidCount === 0
                  ? 'No problems found'
                  : `${invalidCount} row${invalidCount === 1 ? '' : 's'} will be reported as failed`}
              </span>
            </header>
            <table className="table">
              <thead>
                <tr>
                  <th className="w-20">Row</th>
                  <th>Mapped values</th>
                  <th className="w-72">Problems</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row) => (
                  <tr key={row.rowNumber} className={row.errors.length > 0 ? 'bg-red-50/50' : ''}>
                    <td className="text-slate-500">{row.rowNumber}</td>
                    <td className="text-slate-700">
                      {Object.entries({ ...row.values, ...row.customFields })
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(' · ') || <span className="text-slate-400">empty</span>}
                    </td>
                    <td className="text-red-700">{row.errors.join('; ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > preview.length && (
              <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
                Showing the first {preview.length} of {rows.length} rows. All {rows.length} are
                validated before import.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={commit} disabled={pending}>
              {pending
                ? 'Importing…'
                : `Import ${rows.length - invalidCount} row${rows.length - invalidCount === 1 ? '' : 's'}`}
            </button>
            <button type="button" className="btn-secondary" onClick={reset} disabled={pending}>
              Start over
            </button>
          </div>
        </>
      )}
    </div>
  )
}
