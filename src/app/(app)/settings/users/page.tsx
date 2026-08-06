import { requireAdmin, scoped } from '@/lib/tenancy'
import { formatDateTime } from '@/lib/format'
import type { UserRow } from '@/lib/database.types'
import { PageHeader, Section } from '@/components/ui'

import { updateUserRole, updateUserStatus } from '../actions'
import { InviteUserForm } from './invite-form'
import { OrganizationForm } from './organization-form'

export const metadata = { title: 'Users · FLO CRM' }

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  invited: 'bg-amber-100 text-amber-800',
  disabled: 'bg-slate-200 text-slate-600',
}

export default async function UserSettingsPage() {
  const context = await requireAdmin()

  const { data: users } = await scoped(context, 'users').select('*').order('created_at')
  const userList = (users ?? []) as UserRow[]

  return (
    <>
      <PageHeader
        title="Users"
        description="People in this organization. Accounts are provisioned here — there is no public signup."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Section title={`${userList.length} user${userList.length === 1 ? '' : 's'}`}>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last login</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {userList.map((user) => (
                  <tr key={user.id}>
                    <td className="font-medium text-slate-800">{user.name || '—'}</td>
                    <td className="text-slate-600">{user.email}</td>
                    <td>
                      <form action={updateUserRole} className="flex items-center gap-1">
                        <input type="hidden" name="id" value={user.id} />
                        <select name="role" defaultValue={user.role} className="input w-28 py-1">
                          <option value="regular">Regular</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button type="submit" className="text-xs text-slate-500 hover:text-brand-700">
                          Save
                        </button>
                      </form>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_STYLES[user.status]}`}>{user.status}</span>
                    </td>
                    <td className="text-slate-500">{formatDateTime(user.last_login_at)}</td>
                    <td className="text-right">
                      {user.id !== context.user.id && (
                        <form action={updateUserStatus}>
                          <input type="hidden" name="id" value={user.id} />
                          <input
                            type="hidden"
                            name="status"
                            value={user.status === 'disabled' ? 'active' : 'disabled'}
                          />
                          <button type="submit" className="text-xs text-slate-400 hover:text-red-600">
                            {user.status === 'disabled' ? 'Re-enable' : 'Disable'}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
