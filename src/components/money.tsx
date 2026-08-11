import { currencyStyle, formatAmount } from '@/lib/format'

/**
 * An amount with its currency standing to the right of it, in that currency's
 * colour.
 *
 * A leading symbol is ambiguous the moment a board holds more than one
 * currency — `$` is CAD to one reader and USD to another, and a pipeline
 * mixing them gives no clue which is which. The code says it outright, and the
 * colour means a mixed column can be read without reading: CAD red, USD blue,
 * EUR amber, GBP green.
 *
 * The gap is deliberate and part of the point. `1,200USD` is a string;
 * `1,200 USD` is a number and its unit.
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
      <span className={amountClassName || undefined}>{formatAmount(value)}</span>
      <span className={`text-xs font-semibold ${currencyStyle(currency)}`}>
        {(currency ?? '').toUpperCase() || '—'}
      </span>
    </span>
  )
}
