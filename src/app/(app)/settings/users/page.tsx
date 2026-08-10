import { requireAdmin, scoped } from '@/lib/tenancy'
import { formatDateTime } from '@/lib/format'
import type { UserRow } from '@/lib/database.types'
import { USER_ROLES } from '@/lib/field-options'
import { ErrorNote, PageHeader, Section } from '@/components/ui'

import { deleteUser, updateUser } from '../actions'
import { DeleteUserButton } from './delete-user-button'
import { InviteUserForm } from './invite-form'
import { OrganizationForm } from './organization-form'

export const metadata = { title: 'Users · FLO CRM' }

/**
 * `invited` is not an option an administrator can pick — it is where everyone
 * starts and it ends the first time they sign in. The control offers the two
 * states that are actually a decision, and the column says which of the three
 * they are in.
 */
const ACCESS_OPTIONS = [
  { value: 'active', label: 'Allowed' },
  { value: 'disabled', label: 'Paused' },
]

const STATUS_LABELS: Record<string, string> = {
  active: 'Signed in',
  invited: 'Invited',
  disabled: 'Paused',
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  invited: 'bg-amber-100 text-amber-800',
  disabled: 'bg-slate-200 text-slate-600',
}

export default async function UserSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; removed?: string }>
}) {
  const params = await searchParams
  const context = await requireAdmin()

  const { data: users } = await scoped(context, 'users').select('*').order('created_at')
  const userList = (users ?? []) as UserRow[]

  const confirmation = params.saved
    ? `${params.saved} was updated.`
    : params.removed
      ? `${params.removed} was removed from this organization.`
      : null

  return (
    <>
      <PageHeader
        title="Users"
        description="People in this organization. Accounts are provisioned here — there is no public signup."
      />

      {params.error && (
        <div className="mb-5">
          <ErrorNote>{params.error}</ErrorNote>
        </div>
      )}

      {confirmation && (
        <p className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
          {confirmation}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Section title={`${userList.length} user${userList.length === 1 ? '' : 's'}`}>
            <div className="-mx-5 overflow-x-auto px-5">
              <table className="table min-w-[46rem]">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Access</th>
                    <th>Last login</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {userList.map((user) => {
                    // One form per person, spanning the row. The inputs live in
                    // their own cells and join it by id, which keeps the table
                    // layout without nesting a form inside another.
                    const formId = `user-${user.id}`
                    const isSelf = user.id === context.user.id

                    return (
                      <tr key={user.id}>
                        <td>
                          <form id={formId} action={updateUser}>
                            <input type="hidden" name="id" value={user.id} />
                          </form>
                          <label className="sr-only" htmlFor={`${formId}-name`}>
                            Name for {user.email}
                          </label>
                          <input
                            id={`${formId}-name`}
                            form={formId}
                            name="name"
                            defaultValue={user.name}
                            placeholder="No name yet"
                            maxLength={120}
                            className="input w-40 py-1"
                          />
                        </td>

                        <td className="text-slate-600">{user.email}</td>

                        <td>
                          <label className="sr-only" htmlFor={`${formId}-role`}>
                            Role for {user.email}
                          </label>
                          <select
                            id={`${formId}-role`}
                            form={formId}
                            name="role"
                            defaultValue={user.role}
                            className="input w-36 py-1"
                          >
                            {USER_ROLES.map((role) => (
                              <option key={role.value} value={role.value} title={role.description}>
                                {role.label}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td>
                          {/*
                            Your own access is shown, not offered — but it still
                            has to reach the server, because a disabled select
                            submits nothing and the save would arrive incomplete.
                          */}
                          {isSelf ? (
                            <>
                              <input
                                type="hidden"
                                form={formId}
                                name="status"
                                value={user.status === 'disabled' ? 'disabled' : 'active'}
                              />
                              <span className="text-xs text-slate-400">Your own account</span>
                            </>
                          ) : (
                            <>
                              <label className="sr-only" htmlFor={`${formId}-status`}>
                                Access for {user.email}
                              </label>
                              <select
                                id={`${formId}-status`}
                                form={formId}
                                name="status"
                                defaultValue={user.status === 'disabled' ? 'disabled' : 'active'}
                                className="input w-28 py-1"
                              >
                                {ACCESS_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </>
                          )}
                          <span className={`badge mt-1 ${STATUS_STYLES[user.status]}`}>
                            {STATUS_LABELS[user.status] ?? user.status}
                          </span>
                        </td>

                        <td className="text-slate-500">{formatDateTime(user.last_login_at)}</td>

                        <td>
                          <div className="flex items-center justify-end gap-3">
                            <button
                              type="submit"
                              form={formId}
                              className="text-xs text-slate-500 hover:text-brand-700"
                            >
                              Save
                            </button>
                            {!isSelf && (
                              <DeleteUserButton
                                action={deleteUser}
                                id={user.id}
                                label={user.name || user.email}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-xs text-slate-500">
              <strong>Paused</strong> blocks sign-in and can be undone at any time — use it for
              someone on leave or between roles. <strong>Delete</strong> cannot be undone: their
              records stay in the CRM as unassigned, but their saved filters, notifications,
              connected mailbox and any assignment rule routing leads to them are destroyed.
            </p>
          </Section>

          <Section title="Organization">
            <OrganizationForm organization={context.organization} />
          </Section>
        </div>

        <Section title="Invite someone">
          <InviteUserForm />
        </Section>
      </div>
    </>
  )
}
