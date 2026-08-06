import { requireSession, scoped } from '@/lib/tenancy'
import type { TagRow } from '@/lib/database.types'
import { PageHeader, Section } from '@/components/ui'

import { createTag, deleteTag } from '../actions'

export const metadata = { title: 'Tags · FLO CRM' }

export default async function TagsPage() {
  const context = await requireSession()

  const { data: tags } = await scoped(context, 'tags').select('*, contact_tags(count)').order('name')
  const tagList = (tags ?? []) as (TagRow & { contact_tags: { count: number }[] })[]

  return (
    <>
      <PageHeader title="Tags" description="Free-form segmentation on top of lifecycle stage." />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title={`${tagList.length} tag${tagList.length === 1 ? '' : 's'}`}>
            {tagList.length === 0 ? (
              <p className="text-sm text-slate-500">No tags yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {tagList.map((tag) => (
                  <li key={tag.id} className="flex items-center justify-between py-2">
                    <span className="flex items-center gap-2 text-sm text-slate-800">
                      <span
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ backgroundColor: tag.color }}
                        aria-hidden
                      />
                      {tag.name}
                      <span className="text-xs text-slate-400">
                        {tag.contact_tags?.[0]?.count ?? 0} contacts
                      </span>
                    </span>
                    <form action={deleteTag}>
                      <input type="hidden" name="id" value={tag.id} />
                      <button type="submit" className="text-xs text-slate-400 hover:text-red-600">
                        Delete
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <Section title="Add a tag">
          <form action={createTag} className="space-y-3">
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
            <button type="submit" className="btn-primary w-full">
              Add tag
            </button>
          </form>
        </Section>
      </div>
    </>
  )
}
