'use server'

import { revalidatePath } from 'next/cache'

import { requireSession } from '@/lib/tenancy'

/**
 * Disconnecting destroys the stored token rather than hiding the row, so the
 * settings page can still say a mailbox was disconnected. The database function
 * decides whether the caller is allowed — a person may disconnect their own
 * mailbox, an administrator anyone's.
 */
export async function disconnectMailbox(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')

  const { error } = await context.supabase.rpc('disconnect_mailbox', { p_connection_id: id })
  if (error) throw new Error(error.message)

  revalidatePath('/settings/mailboxes')
}

export async function setMailboxBackfill(formData: FormData) {
  const context = await requireSession()
  const id = String(formData.get('id') ?? '')
  const days = Number(formData.get('backfill_days') ?? 30)

  const { error } = await context.supabase.rpc('set_mailbox_backfill', {
    p_connection_id: id,
    p_days: days,
  })

  if (error) throw new Error(error.message)

  revalidatePath('/settings/mailboxes')
}
