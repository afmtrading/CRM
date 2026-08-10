'use server'

import { revalidatePath } from 'next/cache'

import { requireSession, scoped } from '@/lib/tenancy'

/** RLS scopes these to the caller's own inbox, so no id check is needed here. */
export async function markNotificationRead(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  await scoped(context, 'notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)

  revalidatePath('/notifications')
}

export async function markAllNotificationsRead() {
  const context = await requireSession()

  await scoped(context, 'notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null)

  revalidatePath('/notifications')
}
