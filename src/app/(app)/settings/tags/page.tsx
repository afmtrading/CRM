import { requireSession, scoped } from '@/lib/tenancy'
import type { TagRow } from '@/lib/database.types'
import { PageHeader, Section } from '@/components/ui'
import { ActionForm, SubmitButton } from '@/components/action-form'

import { createTag } from '../actions'
import { TagRows, type TagUsage } from './tag-rows'

/*
 * Never served from the route cache.
 *
 * These read per-request, per-tenant data behind an authenticated session, and
 * the App Router will happily hand back a previously rendered page otherwise —
 * which shows up as a deploy that went out and a screen that did not change.
 * The sales and invoice screens have said this since they were written; the
 * rest of the record pages were relying on it not happening.
 */
export const dynamic = 'force-dynamic'

export const metadata = { title: 'Tags · FLO CRM' }

export default async function TagsPage() {
  const context = await requireSession()

  /*
   * Counted across all three joins. The page used to ask only for
   * contact_tags, so a tag used on forty companies and no contacts read as
   * "0 contacts" — which is what somebody deletes.
   */
  const { data: tags } = await scoped(context, 'tags')
    .select('*, contact_tags(count), company_tags(count), product_tags(count)')
    .order('name')

  const tagList = (tags ?? []) as (TagRow & {
    contact_tags: { count: number }[]
    company_tags: { count: number }[]
    product_tags: { count: number }[]
  })[]

  const usage: TagUsage[] = tagList.map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    contacts: tag.contact_tags?.[0]?.count ?? 0,
    companies: tag.company_tags?.[0]?.count ?? 0,
    products: tag.product_tags?.[0]?.count ?? 0,
  }))

  return (
    <>
      <PageHeader title="Tags" />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title={`${usage.length} tag${usage.length === 1 ? '' : 's'}`}>
            <TagRows tags={usage} />
          </Section>
        </div>

        <Section title="Add a tag">
          <ActionForm action={createTag} className="space-y-3">
            <div>
              <label className="label" htmlFor="tag-name">
                Name
              </label>
              <input id="tag-name" name="name" required className="input" placeholder="VIP" />
            </div>
            <div>
              <label className="label" htmlFor="tag-color">
                Colour
              </label>
              <input
                id="tag-color"
                name="color"
                type="color"
                className="input h-9 py-1"
                defaultValue="#0f766e"
              />
            </div>
            <SubmitButton className="btn-primary w-full" pendingLabel="Adding…">
              Add tag
            </SubmitButton>
          </ActionForm>
          <p className="mt-3 text-xs text-slate-400">
            You can also add one while tagging a record — search for it and pick &ldquo;Create&rdquo;.
          </p>
        </Section>
      </div>
    </>
  )
}
