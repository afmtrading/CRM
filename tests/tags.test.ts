import { describe, expect, it } from 'vitest'

import { tagIdsFrom } from '../src/lib/tags'

/*
 * The distinction this file exists for: "no tags" and "did not ask about tags"
 * are different answers, and a form posts nothing in either case. Without the
 * marker field, every save from a screen that does not carry the control would
 * strip the record's tags.
 */
describe('tagIdsFrom', () => {
  const form = (entries: [string, string][]) => {
    const data = new FormData()
    for (const [key, value] of entries) data.append(key, value)
    return data
  }

  it('reads the ticked boxes', () => {
    expect(tagIdsFrom(form([['tags_present', '1'], ['tag_ids', 'a'], ['tag_ids', 'b']]))).toEqual([
      'a',
      'b',
    ])
  })

  it('reads an empty selection as an answer, not as silence', () => {
    expect(tagIdsFrom(form([['tags_present', '1']]))).toEqual([])
  })

  /*
   * The one that matters. A screen without the control posts neither the marker
   * nor any ids, and must leave whatever is stored alone — otherwise editing a
   * contact from a form that never mentioned tags would quietly untag it.
   */
  it('says nothing when the form never asked', () => {
    expect(tagIdsFrom(form([['first_name', 'Ada']]))).toBeNull()
  })

  it('drops blanks rather than storing an empty id', () => {
    expect(tagIdsFrom(form([['tags_present', '1'], ['tag_ids', ''], ['tag_ids', 'a']]))).toEqual([
      'a',
    ])
  })
})
