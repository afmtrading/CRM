/**
 * Turning what a file says into what an option list should hold.
 *
 * Two jobs. Finding the values a column uses that your lists do not have yet,
 * which is counting. And grouping the near-duplicates, which is string
 * similarity — 97 buyer types in one real file that mean about ten things.
 *
 * Neither needs a model. What a model would add is judgement at the edges of
 * the second one, and the answer to that is that a person decides once and the
 * decision is remembered — see import_profiles. A saved rule beats a re-derived
 * guess: it is the same next month, and it gets more accurate as it is used
 * rather than staying wherever it started.
 */

// -----------------------------------------------------------------------------
// Values you do not have yet
// -----------------------------------------------------------------------------

export interface ValueCount {
  value: string
  count: number
}

export interface OptionProposal {
  /** The option list this belongs to — specialty_market, customer_type, … */
  field: string
  label: string
  /** In the file, not in the list. Ordered by how often they appear. */
  missing: ValueCount[]
  /** Already in the list, so nothing to do. Counted for reassurance. */
  known: number
}

/**
 * What a column would add to an option list.
 *
 * Case-insensitive against what is already there, because "General" and
 * "general" are one option and proposing the second is how a list ends up with
 * both.
 */
export function proposeOptions(
  field: string,
  label: string,
  values: string[],
  existing: string[],
): OptionProposal {
  const have = new Set(existing.map((option) => option.trim().toLowerCase()))
  const counts = new Map<string, number>()
  let known = 0

  for (const raw of values) {
    const value = raw.trim()
    if (!value) continue

    if (have.has(value.toLowerCase())) {
      known += 1
      continue
    }
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  return {
    field,
    label,
    missing: [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    known,
  }
}

// -----------------------------------------------------------------------------
// Grouping the near-duplicates
// -----------------------------------------------------------------------------

/** Words too common to say two values are about the same thing. */
const STOP_WORDS = new Set(['and', 'or', 'the', 'of', 'for', 'a', 'an', 'to', 'with'])

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
}

/**
 * Whether two words are the same word.
 *
 * Prefix matching rather than a stemmer: "wholesale" and "wholesaler",
 * "liquidation" and "liquidator", "auction" and "auctioneer". A real stemmer
 * would be better and is a dependency and a pile of rules for a gain nobody
 * would notice here. The five-character floor is what stops "pro" matching
 * "product".
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  return shorter.length >= 5 && longer.startsWith(shorter)
}

function overlap(a: string[], b: string[]): number {
  const shared = a.filter((token) => b.some((other) => sameWord(token, other))).length
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : shared / union
}

/*
 * Subsumption — one token set entirely inside the other — was tried and
 * removed. A single common word acts as a bridge: "Wholesaler" is inside both
 * "Liquidation Wholesaler" and "Distributor/Wholesaler", so those two join
 * through it, and then something joins to them, and on a real file one cluster
 * ended up holding 245 cells across "Named contact", "Marketplace" and
 * "Auctioneer & Buyer". Shared-word overlap alone is the conservative rule, and
 * conservative is right here: a missed merge costs one decision, an over-merge
 * silently destroys a distinction.
 */

export interface ValueCluster {
  /** The value suggested to keep — the one used most. */
  keep: string
  /** Everything proposed to fold into it, including the survivor. */
  members: ValueCount[]
  total: number
}

/**
 * Groups values that look like the same thing written differently.
 *
 * Two values join a cluster when they share enough of their words, and a value
 * joins only if it fits *every* member — not merely one of them. `PLATFORM` and
 * `Marketplace/Platform` come together; `Directory/Marketplace` stays apart,
 * because sharing one word out of three is not enough to call two categories
 * the same thing.
 *
 * The survivor is the one used most, on the grounds that the commonest spelling
 * is usually the house spelling. Every cluster is a suggestion — the point is
 * to turn 97 decisions into about twelve, not to make them.
 */
export function clusterValues(values: ValueCount[], { threshold = 0.5 } = {}): ValueCluster[] {
  const entries = values
    .filter((entry) => entry.value.trim() !== '')
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))

  const tokenised = entries.map((entry) => tokens(entry.value))
  const placed = new Array<boolean>(entries.length).fill(false)
  const clusters: ValueCluster[] = []

  /*
   * Complete linkage: a value joins a cluster only if it is similar to *every*
   * member, not merely to one of them. Single linkage — the obvious union-find
   * — chains, and chaining is how "Liquidation Wholesaler" ended up in the same
   * group as "Named contact" through two intermediate spellings.
   *
   * Clusters are seeded from the commonest value down, so the house spelling is
   * the one the others are measured against and the survivor is decided by
   * usage rather than by iteration order.
   */
  for (let seed = 0; seed < entries.length; seed += 1) {
    if (placed[seed]) continue

    const members = [seed]
    placed[seed] = true

    for (let candidate = seed + 1; candidate < entries.length; candidate += 1) {
      if (placed[candidate]) continue
      if (tokenised[candidate].length === 0 || tokenised[seed].length === 0) continue

      const fitsAll = members.every(
        (member) => overlap(tokenised[member], tokenised[candidate]) >= threshold,
      )

      if (fitsAll) {
        members.push(candidate)
        placed[candidate] = true
      }
    }

    const grouped = members.map((index) => entries[index])
    clusters.push({
      keep: grouped[0].value,
      members: grouped,
      total: grouped.reduce((sum, member) => sum + member.count, 0),
    })
  }

  // Biggest first, and a cluster of one last — those need no decision.
  return clusters.sort(
    (a, b) => b.members.length - a.members.length || b.total - a.total,
  )
}

/**
 * Applies the merges somebody approved.
 *
 * A value with no rule is returned unchanged rather than dropped: a merge table
 * is a set of corrections, not a whitelist, and treating it as one would make
 * every new value disappear the moment a profile existed.
 */
export function applyMerges(values: string[], merges: Record<string, string>): string[] {
  const lookup = new Map(
    Object.entries(merges).map(([from, to]) => [from.trim().toLowerCase(), to]),
  )

  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => lookup.get(value.toLowerCase()) ?? value),
    ),
  ]
}
