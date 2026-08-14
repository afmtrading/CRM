/**
 * What is worth telling somebody about a file they are importing.
 *
 * A fixed list of computed checks rather than open-ended commentary. Every one
 * is arithmetic over the rows, every one carries a count, and every one has
 * something a person could go and do about it.
 *
 * The rule that keeps this panel worth reading: **if it does not have a number
 * attached, it does not go on the list.** "Consider segmenting your outreach"
 * is filler, and a panel containing filler is a panel people learn to skip —
 * which means they skip the one line that mattered.
 */

export type CheckSeverity =
  /** Something is wrong or missing and the count says how much. */
  | 'warning'
  /** True and worth knowing, but not a problem. */
  | 'note'

export interface Check {
  id: string
  severity: CheckSeverity
  /** The finding, with its number in it. */
  headline: string
  /** What it means and what to do, in a sentence. */
  detail: string
  count: number
}

export interface CheckInput {
  rows: { rowNumber: number; values: Record<string, string> }[]
  headers: string[]
  /** Header to target key, as the mapping step left it. */
  mapping: Record<string, string>
}

/** The header mapped to a target, if any. */
function headerFor(mapping: Record<string, string>, target: string): string | null {
  return Object.keys(mapping).find((header) => mapping[header] === target) ?? null
}

function cell(row: { values: Record<string, string> }, header: string | null): string {
  return header ? (row.values[header] ?? '').trim() : ''
}

export function runChecks({ rows, headers, mapping }: CheckInput): Check[] {
  const checks: Check[] = []
  if (rows.length === 0) return checks

  const emailHeader = headerFor(mapping, 'contact.email')
  const phoneHeader = headerFor(mapping, 'contact.phone') ?? headerFor(mapping, 'company.phone')
  const companyHeader = headerFor(mapping, 'company.name')
  const websiteHeader = headerFor(mapping, 'company.domain')

  // ---------------------------------------------------------------------------
  // Nobody can be reached
  // ---------------------------------------------------------------------------
  if (emailHeader || phoneHeader) {
    const unreachable = rows.filter(
      (row) => !cell(row, emailHeader) && !cell(row, phoneHeader),
    )

    if (unreachable.length > 0) {
      const withWebsite = unreachable.filter((row) => cell(row, websiteHeader)).length
      checks.push({
        id: 'unreachable',
        severity: 'warning',
        headline: `${unreachable.length} of ${rows.length} rows have neither an email nor a phone number`,
        detail: withWebsite
          ? `Nobody can action these as they stand. ${withWebsite} of them do have a website, so the contact details are findable.`
          : 'Nobody can action these as they stand.',
        count: unreachable.length,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // A call list rather than an email list
  // ---------------------------------------------------------------------------
  if (emailHeader && phoneHeader) {
    const callOnly = rows.filter((row) => !cell(row, emailHeader) && cell(row, phoneHeader))

    if (callOnly.length > 0) {
      checks.push({
        id: 'phone-only',
        severity: 'note',
        headline: `${callOnly.length} rows have a phone number but no email`,
        detail:
          'These will silently never receive a campaign. They are a call list, and worth keeping as their own list rather than mixed in.',
        count: callOnly.length,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // The same address twice in one file
  // ---------------------------------------------------------------------------
  if (emailHeader) {
    const seen = new Map<string, number>()
    for (const row of rows) {
      const email = cell(row, emailHeader).toLowerCase()
      if (email) seen.set(email, (seen.get(email) ?? 0) + 1)
    }
    const repeated = [...seen.values()].filter((count) => count > 1).length

    if (repeated > 0) {
      checks.push({
        id: 'duplicate-emails',
        severity: 'warning',
        headline: `${repeated} email addresses appear on more than one row`,
        detail:
          'Two rows sharing an address are usually the same person listed twice. Only the first will be imported; the rest are skipped.',
        count: repeated,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Rows that cannot become anything
  // ---------------------------------------------------------------------------
  if (companyHeader) {
    const nameless = rows.filter((row) => !cell(row, companyHeader)).length
    if (nameless > 0) {
      checks.push({
        id: 'no-company',
        severity: 'warning',
        headline: `${nameless} rows have no company name`,
        detail: 'Rows are grouped by company, so these cannot be imported and will be left out.',
        count: nameless,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Columns carrying nothing
  //
  // A column with one value on every row is a statement about the file, not
  // about any record in it — "Outreach Status: To contact" on all 257 rows
  // belongs in the list's name, not on 257 contacts.
  // ---------------------------------------------------------------------------
  const constant: string[] = []
  const empty: string[] = []

  for (const header of headers) {
    const values = rows.map((row) => (row.values[header] ?? '').trim())
    const filled = values.filter(Boolean)

    if (filled.length === 0) {
      empty.push(header)
      continue
    }
    if (filled.length === rows.length && new Set(filled).size === 1) {
      constant.push(header)
    }
  }

  if (constant.length > 0) {
    checks.push({
      id: 'constant-columns',
      severity: 'note',
      headline: `${constant.length} column${constant.length === 1 ? '' : 's'} hold the same value on every row`,
      detail: `${constant.join(', ')} — that is a fact about this file rather than about any record in it. Consider naming the list after it instead of importing it.`,
      count: constant.length,
    })
  }

  if (empty.length > 0) {
    checks.push({
      id: 'empty-columns',
      severity: 'note',
      headline: `${empty.length} column${empty.length === 1 ? '' : 's'} are empty`,
      detail: `${empty.join(', ')} — nothing to import from ${empty.length === 1 ? 'it' : 'them'}.`,
      count: empty.length,
    })
  }

  // ---------------------------------------------------------------------------
  // Columns nobody chose to import
  // ---------------------------------------------------------------------------
  const unmapped = headers.filter(
    (header) => !mapping[header] && rows.some((row) => (row.values[header] ?? '').trim()),
  )

  if (unmapped.length > 0) {
    checks.push({
      id: 'unmapped',
      severity: 'note',
      headline: `${unmapped.length} columns with data in them are not being imported`,
      detail: `${unmapped.join(', ')}. Deliberate is fine — this is here so it is deliberate rather than missed.`,
      count: unmapped.length,
    })
  }

  // ---------------------------------------------------------------------------
  // Personal addresses at a company that has its own domain
  //
  // Not an error. Worth seeing, because a buyer reachable only at a free
  // address is a buyer you lose the day they change jobs.
  // ---------------------------------------------------------------------------
  if (emailHeader && websiteHeader) {
    const free = /@(gmail|hotmail|outlook|yahoo|live|aol|icloud|proton(mail)?)\./i
    const personal = rows.filter(
      (row) => free.test(cell(row, emailHeader)) && cell(row, websiteHeader),
    ).length

    if (personal > 0) {
      checks.push({
        id: 'free-email',
        severity: 'note',
        headline: `${personal} contacts use a free email address at a company that has its own domain`,
        detail:
          'Reachable today, and lost the day they change jobs. Worth a second address on the company itself.',
        count: personal,
      })
    }
  }

  // Warnings first, then by size. The panel is read top-down and largely
  // skimmed, so what needs doing has to be above what is merely true.
  return checks.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'warning' ? -1 : 1
    return b.count - a.count
  })
}
