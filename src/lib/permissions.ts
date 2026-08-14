import type { PermissionSetRow } from '@/lib/database.types'

/**
 * What a permission set can say, phrased for the person ticking the boxes.
 *
 * Kept apart from the screen so the labels are one list rather than one per
 * place they appear, and so the wording that decides whether somebody
 * understands what they are granting is reviewable on its own.
 */

/**
 * Record visibility is a choice of three, not two independent ticks.
 *
 * Underneath it is see_all_records and see_unassigned, and offering those as
 * separate checkboxes would let somebody build "sees unassigned records but not
 * their own", which is not a thing anybody means. Three options cannot be set
 * to nonsense.
 *
 * Unassigned records are visible on purpose in the middle option: assignment
 * routing can leave a record with no owner, and a lead nobody can see is a lead
 * that gets lost.
 */
export const VISIBILITY_OPTIONS = [
  {
    value: 'all',
    label: 'Every record in the organization',
    see_all_records: true,
    see_unassigned: true,
  },
  {
    value: 'own_and_unassigned',
    label: 'Their own, plus anything unassigned',
    see_all_records: false,
    see_unassigned: true,
  },
  {
    value: 'own',
    label: 'Only their own',
    see_all_records: false,
    see_unassigned: false,
  },
] as const

export type Visibility = (typeof VISIBILITY_OPTIONS)[number]['value']

/** Which of the three a set is currently on. */
export function visibilityOf(set: {
  see_all_records: boolean
  see_unassigned: boolean
}): Visibility {
  if (set.see_all_records) return 'all'
  return set.see_unassigned ? 'own_and_unassigned' : 'own'
}

/** The two columns a chosen option writes. Unknown input falls to the narrowest. */
export function visibilityColumns(value: string): {
  see_all_records: boolean
  see_unassigned: boolean
} {
  const option = VISIBILITY_OPTIONS.find((candidate) => candidate.value === value)
  return {
    see_all_records: option?.see_all_records ?? false,
    see_unassigned: option?.see_unassigned ?? false,
  }
}

/**
 * The capabilities that are genuinely on or off, in the order they read.
 *
 * Roughly least to most dangerous, so the two that hand over the building are
 * at the bottom where a reader has already seen the rest.
 */
export const CAPABILITIES = [
  {
    key: 'write_records',
    label: 'Create and edit',
    help: 'Add contacts, companies, deals and activities, and change them.',
  },
  {
    key: 'delete_records',
    label: 'Delete',
    help: 'Deleted records go to the recycle bin rather than disappearing.',
  },
  {
    key: 'manage_records',
    label: 'Manage shared records',
    help: 'Products, campaigns, tags and stock locations — and setting who owns a record.',
  },
  {
    key: 'bulk_records',
    label: 'Import, export and bulk edit',
    help: 'Change many records at once, and take data out of the system.',
  },
  {
    key: 'administer',
    label: 'Settings and the recycle bin',
    help: 'Pipelines, users, fields, mailboxes, and restoring deleted records.',
  },
  {
    key: 'see_hidden',
    label: 'See hidden records',
    help: 'Contacts and companies somebody has hidden. Also the ability to hide and unhide them — one box rather than two, because whoever can hide something has to be able to find it again.',
  },
  {
    key: 'manage_permissions',
    label: 'Manage permissions',
    help: 'Edit these sets and decide who is on them. Deliberately separate from Settings — without it, somebody can run the system without being able to rewrite the rules of it.',
  },
] as const satisfies readonly { key: keyof PermissionSetRow; label: string; help: string }[]

export type CapabilityKey = (typeof CAPABILITIES)[number]['key']

/**
 * A one-line summary of a set, for a list that has no room for the grid.
 *
 * Says what somebody on it can do rather than which columns are true, and says
 * "nothing yet" rather than an empty string, because a blank cell reads as a
 * rendering fault.
 */
export function describeSet(set: PermissionSetRow): string {
  const visibility = VISIBILITY_OPTIONS.find(
    (option) => option.value === visibilityOf(set),
  )?.label

  const granted = CAPABILITIES.filter((capability) => set[capability.key]).map(
    (capability) => capability.label.toLowerCase(),
  )

  if (granted.length === 0) return `${visibility}. Read only — nothing else is ticked.`
  return `${visibility}. ${granted.join(', ')}.`
}
