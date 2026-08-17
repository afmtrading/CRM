import type { FieldDef } from '@/lib/filters'

/**
 * Group and sub-group, for a list that has a plain GET form rather than the
 * FilterBar.
 *
 * Two selects and no client JavaScript. The FilterBar exists for contacts,
 * companies and deals, and it carries conditions, saved views and an export
 * entity along with the grouping; products and marketplaces wanted the
 * grouping and none of the rest, and lifting the whole component across would
 * have meant inventing a saved-view entity type and an export shape for each
 * of them to satisfy props they never use.
 *
 * The second select's options are the ones that were groupable on the *last*
 * request, not the option somebody has just picked in the first select — the
 * form is submitted, not live. That is only ever wrong for one round trip, and
 * a sub-group that ends up equal to its group is treated as one level rather
 * than as an error.
 */
export function GroupControls({
  fields,
  groupBy,
  subGroupBy,
}: {
  fields: FieldDef[]
  groupBy: string
  subGroupBy: string
}) {
  return (
    <>
      <div className="min-w-44">
        <label className="label" htmlFor="group">
          Group by
        </label>
        <select id="group" name="group" className="input" defaultValue={groupBy}>
          <option value="">No grouping</option>
          {fields.map((field) => (
            <option key={field.key} value={field.key}>
              {field.label}
            </option>
          ))}
        </select>
      </div>

      {/*
        Offered only once there is something to nest inside. Rendering it
        disabled instead would leave a control on the page whose only state is
        "not yet", which is a question nobody asked.
      */}
      {groupBy && (
        <div className="min-w-44">
          <label className="label" htmlFor="subgroup">
            Then by
          </label>
          <select id="subgroup" name="subgroup" className="input" defaultValue={subGroupBy}>
            <option value="">No sub-group</option>
            {fields
              .filter((field) => field.key !== groupBy)
              .map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
          </select>
        </div>
      )}
    </>
  )
}
