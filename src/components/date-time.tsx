'use client'

import { useEffect, useState } from 'react'

import { formatDate, formatDateTime } from '@/lib/format'

/**
 * A moment, shown on the reader's own clock.
 *
 * Every page here is server-rendered, and a server has no idea what time it is
 * where you are — on Vercel it is UTC, so "9:40 p.m." meant nothing to somebody
 * sitting in Toronto at 5:40. The timestamp is sent as UTC and reformatted in
 * the browser's zone on mount, which needs no setting and follows a reader who
 * travels.
 *
 * The first render deliberately produces the same UTC text on both sides, so
 * hydration matches exactly and the swap happens once, afterwards. Without
 * JavaScript the UTC reading stays — wrong by hours, but the `dateTime`
 * attribute always carries the unambiguous instant.
 *
 * For a calendar date with no time in it — a close date, a birthday — use
 * `formatDay` instead. Those must not move between zones at all.
 */
export function DateTime({
  value,
  className,
  dateOnly = false,
}: {
  value: string | null | undefined
  className?: string
  /** Show just the date. Still an instant, so still the reader's zone. */
  dateOnly?: boolean
}) {
  const format = dateOnly ? formatDate : formatDateTime
  const [text, setText] = useState(() => format(value, 'UTC'))

  useEffect(() => {
    // No zone argument: the browser's own.
    setText(format(value))
  }, [value, format])

  if (!value) return <span className={className}>—</span>

  return (
    <time dateTime={value} className={className}>
      {text}
    </time>
  )
}
