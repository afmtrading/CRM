import { describe, expect, it } from 'vitest'

import { insertAt, prefixLine, wrapSelection } from '../src/lib/markdown-edit'

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
