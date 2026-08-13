/**
 * What a formatting button does to the text.
 *
 * Pulled out of the editor component so the behaviour can be tested without a
 * DOM. Every function here takes the text and the caret and returns both — a
 * toolbar that formats correctly but leaves the cursor somewhere unexpected is
 * a toolbar people stop using after the third time it happens.
 */

export type EditResult = {
  value: string
  /** Where the selection should sit afterwards. */
  start: number
  end: number
}

/**
 * Wraps the selection — bold, italic, a link.
 *
 * With nothing selected it inserts a placeholder and selects it, so the next
 * keystroke replaces the word rather than landing between two asterisks.
 */
export function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string = before,
  placeholder = 'text',
): EditResult {
  const selected = value.slice(start, end) || placeholder

  return {
    value: `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`,
    start: start + before.length,
    end: start + before.length + selected.length,
  }
}

/**
 * Puts a prefix on the line the caret is in — a heading, a bullet.
 *
 * Toggling: pressing the same button again takes the prefix off rather than
 * stacking a second one, so "## ## Heading" is not a thing anybody can produce
 * by clicking twice.
 */
export function prefixLine(value: string, caret: number, prefix: string): EditResult {
  const lineStart = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1
  const rest = value.slice(lineStart)

  if (rest.startsWith(prefix)) {
    return {
      value: value.slice(0, lineStart) + rest.slice(prefix.length),
      start: Math.max(lineStart, caret - prefix.length),
      end: Math.max(lineStart, caret - prefix.length),
    }
  }

  return {
    value: value.slice(0, lineStart) + prefix + rest,
    start: caret + prefix.length,
    end: caret + prefix.length,
  }
}

/** Drops something in at the caret — a merge field, mostly. */
export function insertAt(value: string, start: number, end: number, text: string): EditResult {
  return {
    value: `${value.slice(0, start)}${text}${value.slice(end)}`,
    start: start + text.length,
    end: start + text.length,
  }
}

// -----------------------------------------------------------------------------
// Lines and lists
// -----------------------------------------------------------------------------

/** The span of whole lines that a selection touches, however partial it is. */
function lineSpan(value: string, start: number, end: number): { from: number; to: number } {
  const from = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const nextBreak = value.indexOf('\n', end)
  return { from, to: nextBreak === -1 ? value.length : nextBreak }
}

const BULLET = /^(\s*)[-*]\s+/
const NUMBERED = /^(\s*)\d+[.)]\s+/

/**
 * Turns every line a selection touches into a list item, or back again.
 *
 * The single-line version of this was the bug people actually hit: selecting
 * three lines and pressing the list button marked one of them. Numbering counts
 * from one down the selection, which is what somebody who highlighted three
 * lines and asked for a numbered list meant.
 *
 * Toggling is all-or-nothing. If every touched line is already this kind of
 * list the marks come off; if only some are, the rest are brought into line,
 * because that is the reading of a half-marked selection that loses no work.
 */
export function listLines(
  value: string,
  start: number,
  end: number,
  kind: 'bullet' | 'numbered',
): EditResult {
  const { from, to } = lineSpan(value, start, end)
  const lines = value.slice(from, to).split('\n')
  const pattern = kind === 'bullet' ? BULLET : NUMBERED
  const already = lines.every((line) => line.trim() === '' || pattern.test(line))

  let counter = 0
  const next = lines.map((line) => {
    if (line.trim() === '') return line
    // Strip whichever marker is there first, so switching between bullets and
    // numbers replaces rather than stacks.
    const bare = line.replace(BULLET, '$1').replace(NUMBERED, '$1')
    if (already) return bare

    counter += 1
    const indent = /^\s*/.exec(bare)?.[0] ?? ''
    const text = bare.slice(indent.length)
    return `${indent}${kind === 'bullet' ? '- ' : `${counter}. `}${text}`
  })

  const replaced = next.join('\n')
  return {
    value: value.slice(0, from) + replaced + value.slice(to),
    start: from,
    end: from + replaced.length,
  }
}

/**
 * What the Return key should do inside a list.
 *
 * Returns null when the caret is not in one, which is the signal to let the
 * browser insert an ordinary newline. Pressing Return on an empty item ends the
 * list instead of adding another empty one — the same escape hatch every editor
 * has, and without it there is no way out of a list except deleting the marker
 * by hand.
 */
export function continueList(value: string, caret: number): EditResult | null {
  const lineStart = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1
  const line = value.slice(lineStart, caret)

  const bullet = /^(\s*)([-*])\s+(.*)$/.exec(line)
  if (bullet) {
    if (bullet[3].trim() === '') return replaceLine(value, lineStart, caret, bullet[1])
    return insertAt(value, caret, caret, `\n${bullet[1]}${bullet[2]} `)
  }

  const numbered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line)
  if (numbered) {
    if (numbered[4].trim() === '') return replaceLine(value, lineStart, caret, numbered[1])
    // Counted up even though the renderer ignores the written number, because
    // the person typing is reading it and 1. 1. 1. looks broken to them.
    const next = Number(numbered[2]) + 1
    return insertAt(value, caret, caret, `\n${numbered[1]}${next}${numbered[3]} `)
  }

  return null
}

/** Empties the current line — how a list is stepped out of. */
function replaceLine(value: string, lineStart: number, caret: number, keep: string): EditResult {
  return {
    value: value.slice(0, lineStart) + keep + value.slice(caret),
    start: lineStart + keep.length,
    end: lineStart + keep.length,
  }
}

// -----------------------------------------------------------------------------
// Alignment
// -----------------------------------------------------------------------------

export type Align = 'left' | 'center' | 'right'

const ALIGN_PREFIX = /^(\s*)::(?:left|center|right)\s+/

/**
 * Puts `::center` and friends in front of every line a selection touches.
 *
 * Left is written as the absence of a prefix rather than as `::left`, because
 * left is what a line does anyway and a message source full of no-op
 * directives is harder to read than one without them. Pressing the same
 * alignment twice clears it for the same reason.
 */
export function alignLines(value: string, start: number, end: number, align: Align): EditResult {
  const { from, to } = lineSpan(value, start, end)
  const lines = value.slice(from, to).split('\n')

  const token = `::${align} `
  const already =
    align !== 'left' &&
    lines.every((line) => line.trim() === '' || line.trimStart().startsWith(token))

  const next = lines.map((line) => {
    if (line.trim() === '') return line
    const bare = line.replace(ALIGN_PREFIX, '$1')
    if (align === 'left' || already) return bare

    const indent = /^\s*/.exec(bare)?.[0] ?? ''
    return `${indent}${token}${bare.slice(indent.length)}`
  })

  const replaced = next.join('\n')
  return {
    value: value.slice(0, from) + replaced + value.slice(to),
    start: from,
    end: from + replaced.length,
  }
}

/**
 * Sets the heading level of the line the caret is in.
 *
 * Not prefixLine: that appends, so going from H2 to H3 would produce
 * "### ## Heading" — the same stacking bug the list buttons had. Any existing
 * level is taken off first, and asking for the level a line already has clears
 * it, which is how a heading becomes a paragraph again.
 */
export function setHeading(value: string, caret: number, level: number): EditResult {
  const lineStart = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1
  const rest = value.slice(lineStart)
  const current = /^(#{1,6})\s+/.exec(rest)

  const bare = current ? rest.slice(current[0].length) : rest
  const wanted = current && current[1].length === level ? '' : `${'#'.repeat(level)} `
  const replaced = wanted + bare

  // The caret keeps its place in the words rather than in the line.
  const offsetInText = Math.max(0, caret - lineStart - (current ? current[0].length : 0))

  return {
    value: value.slice(0, lineStart) + replaced,
    start: lineStart + wanted.length + offsetInText,
    end: lineStart + wanted.length + offsetInText,
  }
}
