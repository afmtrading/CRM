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
