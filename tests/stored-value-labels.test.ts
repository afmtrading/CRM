import { describe, expect, it } from 'vitest'

import {
  DEAL_STATUS_LABELS,
  IMPORT_STATUS_LABELS,
  LIFECYCLE_LABELS,
  USER_ROLE_LABELS,
} from '@/lib/field-options'
import { INVOICE_STATUS_LABELS, SALES_ORDER_STATUS_LABELS } from '@/lib/sales'

/**
 * Every stored vocabulary, and the rule that it has to be written for a reader.
 *
 * Three separate bugs in this codebase were the same bug: a value stored as
 * `lead`, `CA` or `won` reaching the screen as `lead`, `CA` or `won`. The
 * Record<Enum, string> types already force a label to *exist* for every member
 * — TypeScript will not compile a map with one missing. What they cannot force
 * is that somebody wrote a label rather than repeating the key, which is the
 * failure that actually happened.
 *
 * A new enum should be added here at the same time it is added to the database
 * types. If it has no user-facing label map, that is the finding.
 */
const VOCABULARIES = {
  'lifecycle stage': LIFECYCLE_LABELS,
  'deal status': DEAL_STATUS_LABELS,
  'import status': IMPORT_STATUS_LABELS,
  'sales order status': SALES_ORDER_STATUS_LABELS,
  'invoice status': INVOICE_STATUS_LABELS,
  'user role': USER_ROLE_LABELS,
} satisfies Record<string, Record<string, string>>

describe('stored values have labels written for a reader', () => {
  for (const [name, labels] of Object.entries(VOCABULARIES)) {
    describe(name, () => {
      it('labels every value', () => {
        expect(Object.keys(labels).length).toBeGreaterThan(0)
        for (const [value, label] of Object.entries(labels)) {
          expect(label, `${name}.${value}`).toBeTruthy()
        }
      })

      /*
       * The actual guard. `lead: 'lead'` type-checks and reads as a bug on the
       * screen, which is exactly how the originals shipped.
       */
      it('never repeats the stored key back', () => {
        for (const [value, label] of Object.entries(labels)) {
          expect(label, `${name}.${value} is unlabelled`).not.toBe(value)
        }
      })

      /* An underscore is a column name leaking out — `sales_director`. */
      it('contains no column-shaped text', () => {
        for (const [value, label] of Object.entries(labels)) {
          expect(label, `${name}.${value}`).not.toMatch(/_/)
        }
      })

      it('starts with a capital', () => {
        for (const [value, label] of Object.entries(labels)) {
          expect(label[0], `${name}.${value}`).toBe(label[0].toUpperCase())
        }
      })
    })
  }
})
