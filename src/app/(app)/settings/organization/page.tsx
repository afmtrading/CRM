import { requireSession } from '@/lib/tenancy'
import { timeZoneLabel } from '@/lib/timezone'
import { PageHeader, Section } from '@/components/ui'

import { LogoField } from './logo-field'
import { OrganizationForm } from './organization-form'

export const metadata = { title: 'Organization · FLO CRM' }

/**
 * The handful of settings that describe the business rather than the data in it.
 *
 * These lived at the bottom of Settings → Users, which is where they were built
 * and not where anybody would look for them: "what currency are we in" is not a
 * question about who has an account. Same form, its own page.
 */
export default async function OrganizationSettingsPage() {
  const context = await requireSession()

  return (
    <>
      <PageHeader title="Organization" />

      {context.isAdmin && (
        <Section title="Logo">
          <LogoField organization={context.organization} />
        </Section>
      )}

      <Section title={context.organization.name}>
        {context.isAdmin ? (
          <OrganizationForm organization={context.organization} />
        ) : (
          <p className="text-sm text-slate-500">
            Only an administrator can change these. Your organization is priced in{' '}
            <strong>{context.organization.default_currency}</strong> and reads its dates against{' '}
            <strong>{timeZoneLabel(context.organization.timezone)}</strong>.
          </p>
        )}
      </Section>
    </>
  )
}
