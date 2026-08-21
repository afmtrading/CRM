import { describe, expect, it } from 'vitest'

import { isNamed } from '@/lib/sales'

/**
 * The client-side twin of a check constraint.
 *
 * `sales_order_lines` carries:
 *
 *     check (product_id is not null
 *            or nullif(btrim(coalesce(description, '')), '') is not null)
 *
 * A blank row on the Items card is held in the browser until it satisfies
 * this, because inserting one that does not reaches the database, throws, and
 * puts an error page in front of somebody who only clicked Add line. These
 * cases are the constraint's, restated.
 */
describe('isNamed', () => {
  it('a product is a name', () => {
    expect(isNamed({ productId: 'p1', description: '' })).toBe(true)
  })

  it('so is a description', () => {
    expect(isNamed({ productId: '', description: 'Soap' })).toBe(true)
  })

  it('an empty row is not, which is why it is not written', () => {
    expect(isNamed({ productId: '', description: '' })).toBe(false)
  })

  it('whitespace is not a name — btrim, in the constraint', () => {
    expect(isNamed({ productId: '', description: '   ' })).toBe(false)
    expect(isNamed({ productId: '', description: '\t\n' })).toBe(false)
  })

  it('a product with a blank description is still fine', () => {
    // What picking from the catalogue produces: the name comes from the
    // product, so the line's own description is deliberately left empty.
    expect(isNamed({ productId: 'p1', description: '   ' })).toBe(true)
  })
})
