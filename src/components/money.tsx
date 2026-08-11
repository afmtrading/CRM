import { Fragment } from 'react'

import { currencyStyle, currencySymbol, formatAmount, totalsByCurrency } from '@/lib/format'

/**
 * An amount with its currency standing to the right of it, in that currency's
 * colour: `$1,200 USD`.
 *
 * The symbol in front is what makes it read as money at a glance, but on its
 * own it is ambiguous the moment a board holds more than one currency — `$` is
 * CAD to one reader and USD to another. So the code follows the number and says
 * outright which it is, and the colour means a mixed column can be read without
 * reading: CAD red, USD blue, EUR amber, GBP green.
 *
 * The gap before the code is deliberate and part of the point. `$1,200USD` is a
 * string; `$1,200 USD` is a number and its unit.
 */
export function Money({
  value,
  currency,
  className = '',
  amountClassName = '',
}: {
  value: number
  currency: string | null | undefined
  /** Applied to the pair. */
  className?: string
  /** Applied to the number alone, for weight and size. */
  amountClassName?: string
}) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className}`.trim()}>
      <span className={amountClassName || undefined}>
        {currencySymbol(currency)}
        {formatAmount(value)}
      </span>
      <span className={`text-xs font-semibold ${currencyStyle(currency)}`}>
        {(currency ?? '').toUpperCase() || '—'}
      </span>
    </span>
  )
}

/**
 * What a set of deals comes to, one subtotal per currency.
 *
 * Column headings and page totals used to add every value together and label
 * the result with whichever currency happened to come first, which turned two
 * real numbers into one wrong one. Currencies do not add up without a rate, so
 * these stand side by side instead.
 */
export function MoneyTotals({
  rows,
  className = '',
  amountClassName = '',
}: {
  rows: { value?: number | string | null; currency?: string | null }[]
  className?: string
  amountClassName?: string
}) {
  const totals = totalsByCurrency(rows)

  if (totals.length === 0) return <span className={className || undefined}>—</span>

  return (
    <span className={`inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 ${className}`.trim()}>
      {totals.map(({ currency, total }, index) => (
        <Fragment key={currency || index}>
          {index > 0 && <span className="text-slate-300">·</span>}
          <Money value={total} currency={currency} amountClassName={amountClassName} />
        </Fragment>
      ))}
    </span>
  )
}
