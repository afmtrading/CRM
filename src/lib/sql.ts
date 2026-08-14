/**
 * Making user input safe to put inside a LIKE pattern.
 *
 * Not about injection — PostgREST parameterises everything, and nothing here
 * prevents a query from running. It is about `_` and `%` being *operators*
 * inside LIKE and ILIKE rather than characters, which is easy to forget because
 * every other comparison in the app treats them as text.
 *
 * The case that made this worth writing: underscores are ordinary in email
 * addresses. `ilike('email', 'john_doe@acme.com')` matches john_doe@acme.com and
 * also johnXdoe@acme.com, because `_` means "any one character". The importer
 * used that as its duplicate check, so a CSV row could be merged into the wrong
 * person's record — silently, and only for addresses containing an underscore.
 *
 * A company called "50% Off Ltd" is the same failure with the other wildcard:
 * the pattern matches every company whose name starts with "50".
 */

/**
 * Escapes the LIKE metacharacters in a value that is meant to be read literally.
 *
 * The backslash goes first, or it would escape the escapes added after it.
 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

/**
 * A "contains" pattern for a search box.
 *
 * The wildcards this adds are the app's own; anything the person typed is
 * literal, so searching for `50%` finds the company with `50%` in its name
 * rather than everything.
 */
export function likeContains(value: string): string {
  return `%${likeLiteral(value)}%`
}
