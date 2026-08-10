'use client'

/**
 * Deleting a user is the one action on this page with no undo — users have no
 * recycle bin, unlike contacts and deals. So it asks first, and names the
 * person, because "are you sure?" on its own is a question nobody reads.
 */
export function DeleteUserButton({
  action,
  id,
  label,
}: {
  action: (formData: FormData) => Promise<void>
  id: string
  label: string
}) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        const confirmed = window.confirm(
          `Remove ${label} from this organization?\n\n` +
            'Their contacts, companies and deals stay in the CRM as unassigned records. ' +
            'Their saved filters, notifications and any connected mailbox are deleted.\n\n' +
            'This cannot be undone. To keep the account and only block sign-in, set their ' +
            'access to Paused instead.',
        )
        if (!confirmed) event.preventDefault()
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="text-xs text-slate-400 hover:text-red-600">
        Delete
      </button>
    </form>
  )
}
