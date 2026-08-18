'use client'

import { useMemo, useState } from 'react'

import { detectPlaceholders, headerSignature, readTable, writableChanges } from '@/lib/import-analysis'
import { importTargets, suggestTargets, type ImportPlan } from '@/lib/import-plan'
import { runChecks, type Check } from '@/lib/import-checks'
import { clusterValues, type OptionProposal, type ValueCluster } from '@/lib/import-vocabulary'
import type { ImportProfileRow } from '@/lib/database.types'
import { applyImport, findProfile, planImport, saveProfile, type ApplyResult } from './actions'

/**
 * Importing a buyer list.
 *
 * Four steps, and the third is the one that matters: nothing is written until
 * somebody has seen, per company, what would be created and what would change.
 *
 * The file is parsed in the browser with the same functions the server re-runs
 * when applying, so the review is a statement about what will happen rather
 * than an estimate. The plan itself is built on the server, because matching
 * needs the companies already on file.
 */

type Step = 'upload' | 'map' | 'review' | 'done'

export function ImportBuyers({
  customFields = [],
}: {
  /** This organization's own fields, so they can be mapped to like any other. */
  customFields?: { key: string; label: string; entity_type: string }[]
}) {
  const targets = useMemo(() => importTargets(customFields), [customFields])
  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [headerRow, setHeaderRow] = useState(0)
  const [rows, setRows] = useState<{ rowNumber: number; values: Record<string, string> }[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [placeholders, setPlaceholders] = useState<{ value: string; count: number }[]>([])
  const [ignored, setIgnored] = useState<Set<string>>(new Set())
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [proposals, setProposals] = useState<OptionProposal[]>([])
  const [checks, setChecks] = useState<Check[]>([])
  const [profile, setProfile] = useState<ImportProfileRow | null>(null)
  const [signature, setSignature] = useState('')
  const [merges, setMerges] = useState<Record<string, Record<string, string>>>({})
  const [profileName, setProfileName] = useState('')
  const [approved, setApproved] = useState<Set<string>>(new Set())
  const [allowReplace, setAllowReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)

  const nameHeader = useMemo(
    () => Object.keys(mapping).find((key) => mapping[key] === 'contact.name'),
    [mapping],
  )

  /*
   * The columns worth asking about.
   *
   * A spreadsheet saved with trailing commas arrives with a run of nameless
   * columns — fourteen of them on the file that prompted this — and each one
   * used to get its own row here, pushing the real columns off the screen.
   * Nameless *and* empty is not a column somebody forgot to name; it is
   * punctuation. A nameless column that does hold values is kept, because that
   * is a heading somebody forgot to write and the data is real.
   */
  const mappableHeaders = useMemo(
    () =>
      headers.filter(
        (header) => header.trim() !== '' || rows.some((row) => (row.values[header] ?? '').trim()),
      ),
    [headers, rows],
  )

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setError(null)
    setFileName(file.name)

    const table = readTable(await file.text())
    if (table.headers.length === 0) {
      setError('That file has no columns this could read.')
      return
    }

    /*
     * A profile for this shape of file wins over the guess. Matched by the
     * headings rather than the file name, because the file is called something
     * different every month while the columns stay put.
     */
    const shape = headerSignature(table.headers)
    const saved = await findProfile(shape).catch(() => null)
    const suggested = saved?.mapping ?? suggestTargets(table.headers)

    setSignature(shape)
    setProfile(saved)
    setProfileName(saved?.name ?? file.name.replace(/\.csv$/i, ''))
    setMerges(saved?.value_merges ?? {})
    setHeaders(table.headers)
    setHeaderRow(table.headerRow)
    setMapping(suggested)
    setRows(
      table.rows.map((row, index) => ({
        // The row number as a spreadsheet would show it, so a note about row 47
        // sends somebody to row 47.
        rowNumber: table.headerRow + index + 2,
        values: Object.fromEntries(table.headers.map((header, column) => [header, row[column] ?? ''])),
      })),
    )

    // Guessed from whichever column was mapped to the contact's name, so the
    // suggestion follows the mapping rather than a hardcoded column.
    const nameColumn = Object.keys(suggested).find((key) => suggested[key] === 'contact.name')
    const found = nameColumn
      ? detectPlaceholders(table.rows.map((row) => row[table.headers.indexOf(nameColumn)] ?? ''))
      : []
    setPlaceholders(found)

    // A profile that has seen this file before already knows which of these are
    // placeholders, so anything it did not list stays unticked.
    if (saved) {
      const remembered = new Set(saved.placeholders)
      setIgnored(new Set(found.filter((p) => !remembered.has(p.value)).map((p) => p.value)))
    }

    setStep('map')
  }

  async function review() {
    setBusy(true)
    setError(null)
    try {
      const built = await planImport({
        rows,
        mapping,
        placeholders: placeholders.filter((p) => !ignored.has(p.value)).map((p) => p.value),
        valueMerges: merges,
      })
      setPlan(built.plan)
      setProposals(built.proposals)
      setChecks(runChecks({ rows, headers, mapping }))
      // Everything is approved to begin with. The screen exists to take things
      // out, not to make somebody tick two hundred boxes.
      setApproved(new Set(built.plan.companies.map((company) => company.key)))
      setStep('review')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      setResult(
        await applyImport({
          rows,
          mapping,
          placeholders: placeholders.filter((p) => !ignored.has(p.value)).map((p) => p.value),
          valueMerges: merges,
          approved: [...approved],
          allowReplace,
        }),
      )

      // Saved after the import rather than before, so a profile only ever
      // records decisions somebody actually went through with.
      await saveProfile({
        name: profileName,
        signature,
        headers,
        mapping,
        valueMerges: merges,
        placeholders: placeholders.filter((p) => !ignored.has(p.value)).map((p) => p.value),
      }).catch(() => undefined)

      setStep('done')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That import could not be applied.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {error && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      {step === 'upload' && (
        <div className="card p-5">
          <label className="label" htmlFor="buyer-file">
            CSV file
          </label>
          <input
            id="buyer-file"
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            className="input"
          />
          <p className="mt-2 text-sm text-slate-500">
            A title above the headings, a byte-order mark, several phone formats and one company on
            more than one row are all expected. Nothing is written until you have seen what it would
            do.
          </p>
        </div>
      )}

      {step === 'map' && (
        <>
          <div className="card p-5">
            <p className="text-sm text-slate-600">
              <strong className="font-medium text-slate-800">{fileName}</strong> — {rows.length} rows,{' '}
              {headers.length} columns
              {headerRow > 0 && (
                <>
                  , headings found on row {headerRow + 1} (the {headerRow} rows above are a title or
                  notes)
                </>
              )}
              .
            </p>
          </div>

          {profile && (
            <div className="card border-emerald-300 bg-emerald-50 p-5">
              <h3 className="text-sm font-semibold text-emerald-900">
                Read as “{profile.name}”
              </h3>
              <p className="mt-1 text-sm text-emerald-800">
                These columns have been imported {profile.times_used} time
                {profile.times_used === 1 ? '' : 's'} before, so the mapping, the merges and the
                placeholders below are the ones settled last time. Change anything you like — what
                you leave is what gets remembered.
              </p>
            </div>
          )}

          {placeholders.length > 0 && nameHeader && (
            <div className="card border-amber-300 bg-amber-50 p-5">
              <h3 className="text-sm font-semibold text-amber-900">
                Values in “{nameHeader}” that look like placeholders
              </h3>
              <p className="mt-1 mb-3 text-sm text-amber-800">
                A name repeated this often is usually a stand-in for “no named contact”. Left
                ticked, these create a company with no person rather than a person who does not
                exist.
              </p>
              <div className="space-y-1.5">
                {placeholders.map((placeholder) => (
                  <label key={placeholder.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!ignored.has(placeholder.value)}
                      onChange={(event) => {
                        const next = new Set(ignored)
                        if (event.target.checked) next.delete(placeholder.value)
                        else next.add(placeholder.value)
                        setIgnored(next)
                      }}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    <span className="font-medium">{placeholder.value}</span>
                    <span className="text-amber-700">on {placeholder.count} rows</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="card p-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-800">Columns</h3>
            <div className="-mx-5 overflow-x-auto px-5">
              <table className="table min-w-[38rem]">
                <thead>
                  <tr>
                    <th>Column in the file</th>
                    <th>First value</th>
                    <th className="w-64">Goes to</th>
                  </tr>
                </thead>
                <tbody>
                  {mappableHeaders.map((header) => (
                    <tr key={header}>
                      <td className="font-medium text-slate-700">{header}</td>
                      <td className="max-w-56 truncate text-slate-500">
                        {rows.find((row) => row.values[header])?.values[header] ?? '—'}
                      </td>
                      <td>
                        <select
                          value={mapping[header] ?? ''}
                          onChange={(event) => {
                            const next = { ...mapping }
                            if (event.target.value) next[header] = event.target.value
                            else delete next[header]
                            setMapping(next)
                          }}
                          aria-label={`Where ${header} goes`}
                          className="input w-full py-1"
                        >
                          <option value="">Not imported</option>
                          {targets.map((target) => (
                            <option key={target.key} value={target.key}>
                              {target.on === 'company' ? 'Company' : 'Contact'} · {target.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !Object.values(mapping).includes('company.name')}
              onClick={review}
            >
              {busy ? 'Reading…' : 'See what this would do'}
            </button>
            {!Object.values(mapping).includes('company.name') && (
              <span className="text-sm text-slate-500">
                One column has to be the company name — it is what rows are grouped by.
              </span>
            )}
          </div>
        </>
      )}

      {step === 'review' && plan && (
        <Review
          plan={plan}
          checks={checks}
          proposals={proposals}
          merges={merges}
          setMerges={setMerges}
          profileName={profileName}
          setProfileName={setProfileName}
          approved={approved}
          setApproved={setApproved}
          allowReplace={allowReplace}
          setAllowReplace={setAllowReplace}
          busy={busy}
          onApply={apply}
          onBack={() => setStep('map')}
        />
      )}

      {step === 'done' && result && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-slate-800">Imported</h3>
          <dl className="mt-3 grid gap-3 sm:grid-cols-4">
            <Figure label="Companies created" value={result.companiesCreated} />
            <Figure label="Companies updated" value={result.companiesUpdated} />
            <Figure label="Contacts created" value={result.contactsCreated} />
            <Figure label="Contacts already on file" value={result.contactsSkipped} />
          </dl>

          {result.errors.length > 0 && (
            <div className="mt-4">
              <p className="text-sm font-medium text-red-700">
                {result.errors.length} could not be saved
              </p>
              <ul className="mt-1 space-y-0.5 text-sm text-slate-600">
                {result.errors.map((entry) => (
                  <li key={entry.company}>
                    <span className="font-medium">{entry.company}</span> — {entry.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The values a column would add, with the near-duplicates grouped.
 *
 * Clustering turns ninety-odd decisions into about a dozen. It is a suggestion
 * throughout: the survivor is the commonest spelling, and every member can be
 * unpicked. What is settled here is saved with the profile, so it is settled
 * once rather than every month.
 */
function Vocabulary({
  proposal,
  merges,
  onMerge,
}: {
  proposal: OptionProposal
  merges: Record<string, string>
  onMerge: (next: Record<string, string>) => void
}) {
  const clusters = useMemo<ValueCluster[]>(() => clusterValues(proposal.missing), [proposal.missing])
  const grouped = clusters.filter((cluster) => cluster.members.length > 1)
  const singles = clusters.filter((cluster) => cluster.members.length === 1)

  const merge = (cluster: ValueCluster) => {
    const next = { ...merges }
    for (const member of cluster.members) {
      if (member.value !== cluster.keep) next[member.value] = cluster.keep
    }
    onMerge(next)
  }

  const unmerge = (cluster: ValueCluster) => {
    const next = { ...merges }
    for (const member of cluster.members) delete next[member.value]
    onMerge(next)
  }

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-slate-800">
        {proposal.label} — {proposal.missing.length} value
        {proposal.missing.length === 1 ? '' : 's'} you do not have yet
      </h3>
      <p className="mt-1 mb-3 text-sm text-slate-500">
        {proposal.known > 0 && `${proposal.known} cells already match an option you have. `}
        Anything left here is imported as typed; merging first is how the list stays short.
      </p>

      {grouped.length > 0 && (
        <div className="space-y-2">
          {grouped.map((cluster) => {
            const merged = cluster.members.every(
              (member) => member.value === cluster.keep || merges[member.value] === cluster.keep,
            )

            return (
              <div key={cluster.keep} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-slate-600">
                    {cluster.members.length} spellings, {cluster.total} cells — keep
                  </span>
                  <span className="font-medium text-slate-800">{cluster.keep}</span>
                  <button
                    type="button"
                    onClick={() => (merged ? unmerge(cluster) : merge(cluster))}
                    className={
                      merged
                        ? 'rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white'
                        : 'rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50'
                    }
                  >
                    {merged ? 'Merged' : 'Merge these'}
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {cluster.members
                    .filter((member) => member.value !== cluster.keep)
                    .map((member) => `${member.value} (${member.count})`)
                    .join(' · ')}
                </p>
              </div>
            )
          })}
        </div>
      )}

      {singles.length > 0 && (
        <p className="mt-3 text-sm text-slate-500">
          <span className="font-medium text-slate-700">On their own: </span>
          {singles
            .slice(0, 20)
            .map((cluster) => `${cluster.keep} (${cluster.total})`)
            .join(' · ')}
          {singles.length > 20 && ` and ${singles.length - 20} more`}
        </p>
      )}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums text-slate-900">{value}</dd>
    </div>
  )
}

function Review({
  plan,
  checks,
  proposals,
  merges,
  setMerges,
  profileName,
  setProfileName,
  approved,
  setApproved,
  allowReplace,
  setAllowReplace,
  busy,
  onApply,
  onBack,
}: {
  plan: ImportPlan
  checks: Check[]
  proposals: OptionProposal[]
  merges: Record<string, Record<string, string>>
  setMerges: (next: Record<string, Record<string, string>>) => void
  profileName: string
  setProfileName: (next: string) => void
  approved: Set<string>
  setApproved: (next: Set<string>) => void
  allowReplace: boolean
  setAllowReplace: (next: boolean) => void
  busy: boolean
  onApply: () => void
  onBack: () => void
}) {
  const [showing, setShowing] = useState<'all' | 'new' | 'changed' | 'attention'>('all')

  const shown = plan.companies.filter((company) => {
    if (showing === 'new') return !company.matchId
    if (showing === 'changed') return company.matchId && writableChanges(company.changes).length > 0
    if (showing === 'attention') return company.warnings.length > 0 || company.conflicts.length > 0
    return true
  })

  const toggle = (key: string) => {
    const next = new Set(approved)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setApproved(next)
  }

  return (
    <>
      <div className="card p-5">
        <dl className="grid gap-3 sm:grid-cols-5">
          <Figure label="Rows read" value={plan.counts.rows} />
          <Figure label="New companies" value={plan.counts.newCompanies} />
          <Figure label="Updated" value={plan.counts.updatedCompanies} />
          <Figure label="Contacts" value={plan.counts.contacts} />
          <Figure label="Needs a look" value={plan.counts.needsAttention} />
        </dl>
        {plan.counts.unchangedCompanies > 0 && (
          <p className="mt-3 text-sm text-slate-500">
            {plan.counts.unchangedCompanies} already on file with nothing to change.
          </p>
        )}
      </div>

      {checks.length > 0 && (
        <div className="card p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-800">Worth knowing about this file</h3>
          <ul className="space-y-2.5">
            {checks.map((check) => (
              <li key={check.id} className="flex gap-2.5">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    check.severity === 'warning' ? 'bg-amber-500' : 'bg-slate-300'
                  }`}
                />
                <span>
                  <span className="block text-sm font-medium text-slate-800">{check.headline}</span>
                  <span className="block text-sm text-slate-500">{check.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {proposals.map((proposal) => (
        <Vocabulary
          key={proposal.field}
          proposal={proposal}
          merges={merges[proposal.field] ?? {}}
          onMerge={(next) => setMerges({ ...merges, [proposal.field]: next })}
        />
      ))}

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['all', `Everything (${plan.companies.length})`],
            ['new', `New (${plan.counts.newCompanies})`],
            ['changed', `Changed (${plan.counts.updatedCompanies})`],
            ['attention', `Needs a look (${plan.counts.needsAttention})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setShowing(key)}
            className={
              showing === key
                ? 'rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white'
                : 'rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50'
            }
          >
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {shown.map((company) => {
          const changes = writableChanges(company.changes)
          const replacements = changes.filter((change) => change.kind === 'replace')

          return (
            <div key={company.key} className="card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <input
                  type="checkbox"
                  checked={approved.has(company.key)}
                  onChange={() => toggle(company.key)}
                  aria-label={`Import ${company.name}`}
                  className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800">{company.name}</span>
                    {company.matchId ? (
                      <span className="badge bg-blue-50 text-blue-700">
                        matched on {company.matchBasis}
                      </span>
                    ) : (
                      <span className="badge bg-emerald-50 text-emerald-700">new</span>
                    )}
                    {company.contacts.length > 0 && (
                      <span className="text-xs text-slate-500">
                        {company.contacts.length} contact
                        {company.contacts.length === 1 ? '' : 's'}
                      </span>
                    )}
                    <span className="text-xs text-slate-400">
                      row{company.rowNumbers.length === 1 ? '' : 's'} {company.rowNumbers.join(', ')}
                    </span>
                  </div>

                  {changes.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-sm">
                      {changes.map((change) => (
                        <li key={change.field} className="flex flex-wrap items-baseline gap-1.5">
                          <span className="text-slate-500">{change.field}</span>
                          {change.kind === 'replace' && (
                            <>
                              <span className="text-red-700 line-through">
                                {String(change.before)}
                              </span>
                              <span className="text-slate-400">→</span>
                            </>
                          )}
                          <span className="font-medium text-slate-800">
                            {Array.isArray(change.after)
                              ? change.after.join(' · ')
                              : String(change.after)}
                          </span>
                          {change.kind === 'replace' && (
                            <span className="badge bg-amber-50 text-amber-800">overwrites</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {company.conflicts.map((conflict) => (
                    <p key={conflict.field} className="mt-1.5 text-sm text-amber-800">
                      Its rows disagree on {conflict.field}: {conflict.values.join(' · ')} — the
                      first was used.
                    </p>
                  ))}

                  {/* Amber for what was left out, grey for what was read
                      differently and worked. Both are worth seeing; only the
                      first is worth stopping for. */}
                  {company.warnings.map((warning) => (
                    <p key={warning} className="mt-1.5 text-sm text-amber-800">
                      {warning}
                    </p>
                  ))}

                  {company.notes.map((note) => (
                    <p key={note} className="mt-1.5 text-sm text-slate-500">
                      {note}
                    </p>
                  ))}
                </div>
              </div>

              {replacements.length > 0 && !allowReplace && (
                <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-500">
                  {replacements.length} of these would overwrite a value that is already there, and
                  will be left alone unless you allow it below.
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div className="card space-y-3 p-5">
        <label className="flex gap-2.5">
          <input
            type="checkbox"
            checked={allowReplace}
            onChange={(event) => setAllowReplace(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300"
          />
          <span>
            <span className="block text-sm font-medium text-slate-800">
              Let this file overwrite values that are already filled in
            </span>
            <span className="block text-xs text-slate-500">
              Off by default. Filling a blank always happens; replacing “President” with “Buyer” is
              a decision, and this is where it gets made.
            </span>
          </span>
        </label>

        <div>
          <label className="label" htmlFor="profile-name">
            Remember these columns as
          </label>
          <input
            id="profile-name"
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            maxLength={120}
            className="input w-72"
          />
          <p className="mt-1 text-xs text-slate-500">
            The mapping, the merges and the placeholder decisions are saved against these column
            headings. The next file with the same columns starts here rather than from scratch.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-primary" disabled={busy || approved.size === 0} onClick={onApply}>
            {busy ? 'Importing…' : `Import ${approved.size} compan${approved.size === 1 ? 'y' : 'ies'}`}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>
            Back to columns
          </button>
        </div>
      </div>
    </>
  )
}
