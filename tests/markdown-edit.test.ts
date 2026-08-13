import { describe, expect, it } from 'vitest'

import {
  alignLines,
  continueList,
  insertAt,
  listLines,
  prefixLine,
  setHeading,
  wrapSelection,
} from '../src/lib/markdown-edit'

/*
 * A toolbar that formats correctly but leaves the caret somewhere unexpected is
 * one people stop using after the third time it happens, so every case here
 * asserts on the selection as well as on the text.
 */

describe('wrapSelection', () => {
  it('wraps what is selected', () => {
    const result = wrapSelection('make this bold', 5, 9, '**')

    expect(result.value).toBe('make **this** bold')
    // The selection still covers the word, so typing replaces it rather than
    // landing outside the asterisks.
    expect(result.value.slice(result.start, result.end)).toBe('this')
  })

  it('inserts a placeholder when nothing is selected, and selects it', () => {
    const result = wrapSelection('', 0, 0, '**')

    expect(result.value).toBe('**text**')
    expect(result.value.slice(result.start, result.end)).toBe('text')
  })

  it('takes a different closing string, for links', () => {
    const result = wrapSelection('see the docs', 8, 12, '[', '](https://)', 'link text')

    expect(result.value).toBe('see the [docs](https://)')
    expect(result.value.slice(result.start, result.end)).toBe('docs')
  })

  it('names the placeholder after what it is for', () => {
    const result = wrapSelection('', 0, 0, '![', '](https://)', 'alt text')
    expect(result.value).toBe('![alt text](https://)')
  })
})

describe('prefixLine', () => {
  it('puts the prefix on the line the caret is in, not the first one', () => {
    const result = prefixLine('first\nsecond', 8, '## ')
    expect(result.value).toBe('first\n## second')
  })

  it('keeps the caret on the same character it was on', () => {
    const value = 'heading'
    const result = prefixLine(value, 3, '## ')

    expect(result.value).toBe('## heading')
    expect(result.value[result.start]).toBe(value[3])
  })

  it('toggles off rather than stacking a second prefix', () => {
    // Clicking Heading twice should not produce "## ## Heading".
    const once = prefixLine('Heading', 0, '## ')
    const twice = prefixLine(once.value, once.start, '## ')

    expect(once.value).toBe('## Heading')
    expect(twice.value).toBe('Heading')
  })

  it('works at the very start of the text', () => {
    expect(prefixLine('bullet', 0, '- ').value).toBe('- bullet')
  })

  it('leaves other lines alone', () => {
    const result = prefixLine('- one\ntwo\n- three', 7, '- ')
    expect(result.value).toBe('- one\n- two\n- three')
  })
})

describe('insertAt', () => {
  it('drops a merge field in at the caret', () => {
    const result = insertAt('Hello , welcome', 6, 6, '{{first_name}}')

    expect(result.value).toBe('Hello {{first_name}}, welcome')
    // Caret lands after the field, ready to keep typing.
    expect(result.start).toBe(result.end)
    expect(result.value.slice(result.start)).toBe(', welcome')
  })

  it('replaces a selection rather than pushing it aside', () => {
    const result = insertAt('Hello NAME,', 6, 10, '{{first_name}}')
    expect(result.value).toBe('Hello {{first_name}},')
  })
})

describe('listLines', () => {
  it('marks every line a selection touches, not just the caret one', () => {
    // This was the bug: highlighting three lines marked one of them.
    const value = 'one\ntwo\nthree'
    const result = listLines(value, 0, value.length, 'bullet')

    expect(result.value).toBe('- one\n- two\n- three')
  })

  it('numbers a selection from one downwards', () => {
    const value = 'one\ntwo\nthree'
    expect(listLines(value, 0, value.length, 'numbered').value).toBe('1. one\n2. two\n3. three')
  })

  it('works from a partial selection, because people highlight mid-word', () => {
    const value = 'one\ntwo\nthree'
    // From the middle of "one" to the middle of "two".
    const result = listLines(value, 1, 5, 'bullet')
    expect(result.value).toBe('- one\n- two\nthree')
  })

  it('takes the marks off when every line already has them', () => {
    const value = '- one\n- two'
    expect(listLines(value, 0, value.length, 'bullet').value).toBe('one\ntwo')
  })

  it('brings a half-marked selection into line rather than stripping it', () => {
    // Losing the mark on the line that had one would throw away work; adding
    // one to the line that lacked it is what was asked for.
    const value = '- one\ntwo'
    expect(listLines(value, 0, value.length, 'bullet').value).toBe('- one\n- two')
  })

  it('replaces one kind of list with the other rather than stacking them', () => {
    const value = '- one\n- two'
    expect(listLines(value, 0, value.length, 'numbered').value).toBe('1. one\n2. two')
  })

  it('leaves blank lines blank and does not count them', () => {
    const value = 'one\n\ntwo'
    expect(listLines(value, 0, value.length, 'numbered').value).toBe('1. one\n\n2. two')
  })

  it('selects what it changed, so a second press toggles the same block', () => {
    const value = 'one\ntwo'
    const once = listLines(value, 0, value.length, 'bullet')
    const twice = listLines(once.value, once.start, once.end, 'bullet')

    expect(twice.value).toBe('one\ntwo')
  })
})

describe('continueList', () => {
  it('carries a bullet onto the next line', () => {
    const value = '- one'
    const result = continueList(value, value.length)

    expect(result?.value).toBe('- one\n- ')
    expect(result?.start).toBe(result?.value.length)
  })

  it('counts the next number up', () => {
    const value = '1. one'
    expect(continueList(value, value.length)?.value).toBe('1. one\n2. ')
  })

  it('keeps counting past nine', () => {
    const value = '- a\n9. nine'
    expect(continueList(value, value.length)?.value).toBe('- a\n9. nine\n10. ')
  })

  it('keeps the closing character the writer chose', () => {
    const value = '1) one'
    expect(continueList(value, value.length)?.value).toBe('1) one\n2) ')
  })

  it('steps out of the list when the item is empty', () => {
    // Without this there is no way out of a list except deleting the marker.
    const value = '- one\n- '
    expect(continueList(value, value.length)?.value).toBe('- one\n')
  })

  it('says nothing when the caret is not in a list', () => {
    expect(continueList('just a sentence', 15)).toBeNull()
    expect(continueList('', 0)).toBeNull()
  })

  it('keeps the indent of a nested item', () => {
    const value = '  - nested'
    expect(continueList(value, value.length)?.value).toBe('  - nested\n  - ')
  })
})

describe('alignLines', () => {
  it('marks every line a selection touches', () => {
    const value = 'one\ntwo'
    expect(alignLines(value, 0, value.length, 'center').value).toBe('::center one\n::center two')
  })

  it('writes left as no prefix at all, because that is what a line does anyway', () => {
    const value = '::center one'
    expect(alignLines(value, 0, value.length, 'left').value).toBe('one')
  })

  it('replaces one alignment with another rather than stacking them', () => {
    const value = '::center one'
    expect(alignLines(value, 0, value.length, 'right').value).toBe('::right one')
  })

  it('clears when the same alignment is applied twice', () => {
    const value = 'one'
    const once = alignLines(value, 0, value.length, 'center')
    const twice = alignLines(once.value, once.start, once.end, 'center')

    expect(twice.value).toBe('one')
  })

  it('sits in front of a heading rather than breaking it', () => {
    const value = '## Heading'
    expect(alignLines(value, 0, value.length, 'center').value).toBe('::center ## Heading')
  })
})

describe('setHeading', () => {
  it('makes a line a heading', () => {
    expect(setHeading('Heading', 0, 2).value).toBe('## Heading')
  })

  it('swaps one level for another rather than stacking them', () => {
    // prefixLine would have produced "### ## Heading" here.
    expect(setHeading('## Heading', 0, 3).value).toBe('### Heading')
    expect(setHeading('#### Heading', 0, 1).value).toBe('# Heading')
  })

  it('clears the heading when the same level is asked for twice', () => {
    const once = setHeading('Heading', 0, 2)
    expect(setHeading(once.value, once.start, 2).value).toBe('Heading')
  })

  it('keeps the caret among the words rather than in the hashes', () => {
    const value = 'Heading'
    const result = setHeading(value, 4, 2)

    expect(result.value).toBe('## Heading')
    expect(result.value[result.start]).toBe(value[4])
  })

  it('only touches the line the caret is in', () => {
    const value = 'first\nsecond'
    expect(setHeading(value, 8, 2).value).toBe('first\n## second')
  })
})
