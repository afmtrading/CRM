import { describe, expect, it } from 'vitest'

import { resolveStatus, wouldRemoveLastAdmin, type UserSnapshot } from '../src/lib/users'

const user = (overrides: Partial<UserSnapshot> = {}): UserSnapshot => ({
  id: 'u1',
  role: 'admin',
  status: 'active',
  auth_provider_id: 'auth-1',
  ...overrides,
})

describe('resolveStatus', () => {
  it('activates somebody who has signed in before', () => {
    expect(resolveStatus('active', user({ status: 'disabled' }))).toBe('active')
  })

  it('leaves an outstanding invitation as an invitation', () => {
    // Marking them active would claim an account exists that nobody has ever
    // used, and leave the sign-in trigger nothing to flip.
    expect(resolveStatus('active', user({ status: 'invited', auth_provider_id: null }))).toBe(
      'invited',
    )
  })

  it('pauses either of them', () => {
    expect(resolveStatus('disabled', user())).toBe('disabled')
    expect(resolveStatus('disabled', user({ status: 'invited', auth_provider_id: null }))).toBe(
      'disabled',
    )
  })
})

describe('wouldRemoveLastAdmin', () => {
  it('stops the last administrator being demoted', () => {
    expect(
      wouldRemoveLastAdmin({
        user: user(),
        activeAdminCount: 1,
        next: { role: 'regular', status: 'active' },
      }),
    ).toBe(true)
  })

  it('stops the last administrator being paused', () => {
    expect(
      wouldRemoveLastAdmin({
        user: user(),
        activeAdminCount: 1,
        next: { role: 'admin', status: 'disabled' },
      }),
    ).toBe(true)
  })

  it('stops the last administrator being deleted', () => {
    expect(wouldRemoveLastAdmin({ user: user(), activeAdminCount: 1 })).toBe(true)
  })

  it('allows the change once a second administrator exists', () => {
    expect(
      wouldRemoveLastAdmin({
        user: user(),
        activeAdminCount: 2,
        next: { role: 'regular', status: 'active' },
      }),
    ).toBe(false)
  })

  it('allows a rename or any other change that keeps them an active admin', () => {
    expect(
      wouldRemoveLastAdmin({
        user: user(),
        activeAdminCount: 1,
        next: { role: 'admin', status: 'active' },
      }),
    ).toBe(false)
  })

  it('ignores users who were never the administrator holding the door open', () => {
    expect(
      wouldRemoveLastAdmin({
        user: user({ role: 'regular' }),
        activeAdminCount: 1,
        next: { role: 'readonly', status: 'active' },
      }),
    ).toBe(false)
  })

  /*
   * A paused or invited administrator cannot sign in, so they were never the
   * one keeping the organization reachable — and counting them would let the
   * genuinely last active admin be removed.
   */
  it('does not treat a paused administrator as the last one', () => {
    expect(wouldRemoveLastAdmin({ user: user({ status: 'disabled' }), activeAdminCount: 1 })).toBe(
      false,
    )
  })

  it('does not treat an administrator who has never signed in as the last one', () => {
    expect(
      wouldRemoveLastAdmin({
        user: user({ status: 'invited', auth_provider_id: null }),
        activeAdminCount: 1,
      }),
    ).toBe(false)
  })
})
