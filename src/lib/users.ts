/**
 * The rules that decide whether a change to a user account is allowed.
 *
 * Pure on purpose. These are the parts worth being certain about — an
 * organization that locks itself out of its own administration has no way back
 * through the interface, and "active" meaning two different things would show
 * people as working accounts before they have ever signed in. Keeping them here
 * rather than inline in a server action is what makes them testable without a
 * database.
 */

/** What an administrator may set. `invited` is a lifecycle state, not a choice. */
export type ChosenStatus = 'active' | 'disabled'

/** What is actually stored. */
export type StoredStatus = 'active' | 'invited' | 'disabled'

export type UserSnapshot = {
  id: string
  role: string
  status: StoredStatus
  /** Set the first time they sign in. Null means the invitation is outstanding. */
  auth_provider_id: string | null
}

/**
 * Translates the administrator's choice into a stored status.
 *
 * Choosing "active" for somebody who has never signed in cannot make them
 * active — it would claim a working account exists where only an invitation
 * does, and the sign-in trigger would have nothing left to flip. They stay
 * `invited` until they actually arrive.
 */
export function resolveStatus(chosen: ChosenStatus, user: UserSnapshot): StoredStatus {
  if (chosen === 'disabled') return 'disabled'
  return user.auth_provider_id ? 'active' : 'invited'
}

/**
 * Would this change leave the organization with no administrator who can sign
 * in?
 *
 * Deliberately wider than "don't demote yourself": an administrator pausing or
 * demoting the *other* last administrator locks everyone out just as
 * thoroughly, and is easier to do by accident. Paused and invited admins do not
 * count — an account that cannot sign in cannot restore anybody else's.
 *
 * `activeAdminCount` is the number of users with role `admin` and status
 * `active`, counted before the change.
 */
export function wouldRemoveLastAdmin(options: {
  user: UserSnapshot
  activeAdminCount: number
  /** Absent when the user is being deleted outright. */
  next?: { role: string; status: StoredStatus }
}): boolean {
  const { user, activeAdminCount, next } = options

  // Only an administrator who can sign in today is holding the door open.
  if (user.role !== 'admin' || user.status !== 'active') return false
  if (activeAdminCount > 1) return false

  // Deletion removes them outright.
  if (!next) return true

  return next.role !== 'admin' || next.status !== 'active'
}
