// Search and order for the exercise picker, as pure functions so the two rules that matter
// mid-workout are pinned by tests rather than by scrolling a 1,500-row list on a phone.
//
// Ordering: what you have already done comes first — under every filter and every search,
// not only the "Chosen" tab. The usage map counts routine slots and logged entries; ties fall
// back to the name, and the never-used tail keeps the dataset's own order so the list does
// not reshuffle under your thumb between two keystrokes.
//
// Matching: every word of the query has to be found, in any field, in any order. A query is
// how you remember the exercise, not how the dataset spelled it — "row cable" must find
// "Cable Row", and "db curl" must not, because "db" is nowhere in it.

const norm = s => String(s || '').toLowerCase()

/** The query as words. Empty for a blank query, which matches everything. */
export const queryWords = q => norm(q).split(/\s+/).filter(Boolean)

/** True when every word of `q` is contained in the exercise's name, target, equipment or description. */
export function matchesQuery(e, q) {
  const words = Array.isArray(q) ? q : queryWords(q)
  if (!words.length) return true
  const hay = [e.n, e.tg, e.eq, e.desc].map(norm)
  return words.every(w => hay.some(h => h.includes(w)))
}

/**
 * Exercises you have used first, most-used at the top, names breaking ties; the rest after,
 * in the order they came. `usage` maps exercise id → count (see usageMap in sheets.jsx).
 */
export function rankByUsage(list, usage = {}) {
  const used = [], fresh = []
  list.forEach(e => (usage[e.id] > 0 ? used : fresh).push(e))
  used.sort((a, b) => (usage[b.id] - usage[a.id]) || (norm(a.n) < norm(b.n) ? -1 : norm(a.n) > norm(b.n) ? 1 : 0))
  return used.concat(fresh)
}
