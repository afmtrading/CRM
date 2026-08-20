import { redirect } from 'next/navigation'

import { requireSession, scoped } from '@/lib/tenancy'
import type { PermissionSetRow } from '@/lib/database.types'
import { CAPABILITIES, VISIBILITY_OPTIONS, visibilityOf } from '@/lib/permissions'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { USER_ROLE_LABELS } from '@/lib/field-options'
import { PageHeader, Section } from '@/components/ui'

import {
  createPermissionSet,
  deletePermissionSet,
  updatePermissionSet,
} from '../actions'

export const metadata = { title: 'Permissions · FLO CRM' }

export default async function PermissionSettingsPage() {
  const context = await requireSession()

  // Not requireAdmin: this screen is behind its own capability, so that
  // Settings can be handed out without handing over the rules of the building.
  if (!context.canManagePermissions) redirect('/?error=permission')

  type Members = { permission_set_id: string; members: number }

  const [{ data: sets }, { data: memberRows }] = await Promise.all([
    scoped(context, 'permission_sets').select('*').order('name'),
    context.supabase.rpc('permission_set_members'),
  ])

  const setList = (sets ?? []) as PermissionSetRow[]
  const members = new Map<string, number>(
    ((memberRows ?? []) as Members[]).map((row) => [row.permission_set_id, row.members]),
  )

  return (
    <>
      <PageHeader title="Permissions" />

      <div className="card mb-5 p-4">
        <p className="mb-3 text-sm text-slate-600">
          Everybody starts on the set matching their role. Put somebody on a set directly from{' '}
          <a href="/settings/users" className="text-brand-700 hover:underline">
            Users
          </a>{' '}
          and their role stops deciding for them.
        </p>

        <ActionForm action={createPermissionSet} className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="new-set-name">
              New permission set
            </label>
            <input
              id="new-set-name"
              name="name"
              required
              maxLength={80}
              className="input w-64"
              placeholder="Ops"
            />
          </div>
          <SubmitButton className="btn-primary" pendingLabel="Creating…">
            Create
          </SubmitButton>
        </ActionForm>
      </div>

      <div className="space-y-5">
        {setList.map((set) => {
          const count = members.get(set.id) ?? 0
          const formId = `set-${set.id}`

          return (
            <Section
              key={set.id}
              title={set.name}
              actions={
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-slate-500">
                    {count === 0 ? 'Nobody' : count === 1 ? '1 person' : `${count} people`}
                  </span>
                  {set.role && (
                    <span
                      className="badge bg-slate-100 text-slate-600"
                      title={`Anyone whose role is ${USER_ROLE_LABELS[set.role] ?? set.role} and who is not on a set of their own lands here.`}
                    >
                      role default
                    </span>
                  )}
                  <ActionForm action={deletePermissionSet}>
                    <input type="hidden" name="id" value={set.id} />
                    <SubmitButton
                      className="text-xs text-slate-400 hover:text-red-600"
                      pendingLabel="…"
                    >
                      Delete
                    </SubmitButton>
                  </ActionForm>
                </div>
              }
            >
              <ActionForm action={updatePermissionSet} className="space-y-4">
                <input type="hidden" name="id" value={set.id} />

                <div className="flex flex-wrap items-end gap-4">
                  <div>
                    <label className="label" htmlFor={`${formId}-name`}>
                      Name
                    </label>
                    <input
                      id={`${formId}-name`}
                      name="name"
                      defaultValue={set.name}
                      required
                      maxLength={80}
                      className="input w-56"
                    />
                  </div>

                  {/*
                    Three options rather than two checkboxes. The columns
                    underneath are see_all_records and see_unassigned, and
                    offering those separately would let somebody build "sees
                    unassigned records but not their own", which is not a thing
                    anybody means.
                  */}
                  <div>
                    <label className="label" htmlFor={`${formId}-visibility`}>
                      Which records they see
                    </label>
                    <select
                      id={`${formId}-visibility`}
                      name="visibility"
                      defaultValue={visibilityOf(set)}
                      className="input w-72"
                    >
                      {VISIBILITY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <fieldset className="grid gap-2.5 sm:grid-cols-2">
                  <legend className="label mb-1">What they can do</legend>
                  {CAPABILITIES.map((capability) => (
                    <label
                      key={capability.key}
                      className="flex gap-2.5 rounded-lg border border-slate-200 p-2.5"
                    >
                      <input
                        type="checkbox"
                        name={capability.key}
                        defaultChecked={set[capability.key]}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800">
                          {capability.label}
                        </span>
                        <span className="block text-xs text-slate-500">{capability.help}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>

                <SubmitButton className="btn-primary" pendingLabel="Saving…">
                  Save
                </SubmitButton>
              </ActionForm>
            </Section>
          )
        })}
      </div>
    </>
  )
}
