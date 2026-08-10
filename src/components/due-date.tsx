'use client'

import { useEffect, useState } from 'react'

import { dueLabel, type DueTone } from '@/lib/format'

/**
 * "Today", "Tomorrow", "3d overdue" — decided by the reader's calendar.
 *
 * Whether a task is due today is a question about where *you* are. At 9 p.m. in
 * Toronto it is already tomorrow in UTC, so a server-rendered label calls
 * tonight's task overdue and tomorrow's task today, for the last few hours of
 * every working day.
 *
 * Same shape as `<DateTime>`: the first render is computed in UTC on both
 * sides so hydration matches, then the effect recomputes in the browser's zone.
 */

export const DUE_TONE: Record<DueTone, string> = {
  overdue: 'font-medium text-red-600',
  today: 'font-medium text-amber-600',
  upcoming: 'text-slate-500',
  none: 'text-slate-400',
}

export function DueDate({
  value,
  prefix,
  className,
}: {
  value: string | null | undefined
  /** e.g. "Due " — kept out of the label so the tone colours both alike. */
  prefix?: string
  className?: string
}) {
  const [due, setDue] = useState(() => dueLabel(value, 'UTC'))

  useEffect(() => {
    setDue(dueLabel(value))
  }, [value])

  return (
    <span className={`${DUE_TONE[due.tone]} ${className ?? ''}`.trim()}>
      {prefix}
      {due.label}
    </span>
  )
}

/**
 * How many of these are overdue, counted on the reader's calendar.
 *
 * The dashboard's headline number, which has the same problem as the labels
 * beneath it and would otherwise disagree with them.
 */
export function OverdueCount({ dates }: { dates: (string | null)[] }) {
  const count = (timeZone?: string) =>
    dates.filter((date) => dueLabel(date, timeZone).tone === 'overdue').length

  const [overdue, setOverdue] = useState(() => count('UTC'))

  useEffect(() => {
    setOverdue(count())
    // `dates` is rebuilt on every server render; comparing by value keeps this
    // from looping on a new array with identical contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates.join('|')])

  return <>{overdue}</>
}
