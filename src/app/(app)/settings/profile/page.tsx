import { requireSession, scoped } from '@/lib/tenancy'
import { PageHeader, Section } from '@/components/ui'
import { USER_ROLE_LABELS } from '@/lib/field-options'
import type { UserRow } from '@/lib/database.types'

import { ProfileForm } from './profile-form'

export const metadata = { title: 'My profile · FLO CRM' }
export const dynamic = 'force-dynamic'

/**
 * The person, rather than the business.
 *
 * Everything else under Settings is an administrator's; this is the one page a
 * rep can open, and it exists because their name and number are printed on
 * every document they represent. Somebody who changes desks should not have to
 * ask an administrator to correct the phone number on next month's orders.
 */
export default async function ProfileSettingsPage() {
  const context = await requireSession()

  const { data } = await scoped(context, 'users')
    .select('*')
    .eq('id', context.user.id)
    .maybeSingle()

  const me = (data ?? context.user) as UserRow

  return (
    <>
      <PageHeader
        title="My profile"
        description="What appears on the purchase orders and invoices you represent."
      />

      <Section title={me.name || me.email}>
        <ProfileForm user={me} />
        <p className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-400">
          You are signed in as <strong>{me.email}</strong> ·{' '}
          {USER_ROLE_LABELS[me.role] ?? me.role}. Both are set by an administrator — an email
          address is how you sign in, so changing it is not something a profile page can do
          safely on its own.
        </p>
      </Section>
    </>
  )
}
