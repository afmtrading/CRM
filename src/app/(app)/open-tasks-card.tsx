'use client'

import { AlertIcon } from '@/components/icons'
import { StatCard } from '@/components/ui'
import { dueLabel } from '@/lib/format'

import { useEffect, useState } from 'react'

/**
 * The open-tasks tile, counted on the reader's calendar.
 *
 * It is a client component only because "overdue" depends on where you are —
 * see `<DueDate>`. Without this the headline would be computed in UTC while the
 * list of tasks directly beneath it was computed locally, and the two would
 * disagree for the last hours of every evening.
 */
export function OpenTasksCard({ dueDates }: { dueDates: (string | null)[] }) {
  const tally = (timeZone?: string) =>
    dueDates.filter((due) => dueLabel(due, timeZone).tone === 'overdue').length

  const [overdue, setOverdue] = useState(() => tally('UTC'))

  useEffect(() => {
    setOverdue(tally())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dueDates.join('|')])

  return (
    <StatCard
      label="My open tasks"
      value={String(dueDates.length)}
      href="/activities"
      icon={AlertIcon}
      tone={overdue > 0 ? 'red' : 'amber'}
      trend={overdue > 0 ? { label: `${overdue} overdue`, direction: 'down' } : undefined}
    />
  )
}
