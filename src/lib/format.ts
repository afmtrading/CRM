/**
 * Currencies the app offers. One list, so a product and the deal it lands on
 * can never drift onto different menus.
 */
export const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP'] as const

export function formatCurrency(value: number, currency = 'CAD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value ?? 0)
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-CA').format(value ?? 0)
}

export function formatPercent(value: number): string {
  return `${Math.round((value ?? 0) * 100)}%`
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function contactName(contact: { first_name?: string | null; last_name?: string | null; email?: string | null }): string {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim()
  return name || contact.email || 'Unnamed contact'
}

export function initials(value: string): string {
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

/** Relative day label for due dates, so overdue work reads as overdue. */
export function dueLabel(due: string | null | undefined): { label: string; tone: 'overdue' | 'today' | 'upcoming' | 'none' } {
  if (!due) return { label: '—', tone: 'none' }

  const dueDate = new Date(due)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDue = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate())
  const days = Math.round((startOfDue.getTime() - startOfToday.getTime()) / 86_400_000)

  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: 'overdue' }
  if (days === 0) return { label: 'Today', tone: 'today' }
  if (days === 1) return { label: 'Tomorrow', tone: 'upcoming' }
  return { label: formatDate(due), tone: 'upcoming' }
}
