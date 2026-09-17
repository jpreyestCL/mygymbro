// "Save as routine" from a past workout: the exercises you pick from a day you trained become
// a routine you can schedule. Pure, so the one rule that matters — what plan each exercise
// gets — is pinned by tests instead of by clicking through History.
import { defaultConfig, modeOf, cleanupSg } from './history.js'
import { isWarmupRow, modeForEntry } from './workout-model.js'

/** The routine config one finished entry stands for. */
export function configFromEntry(entry) {
  const target = entry && entry.target
  // Every workout started from a routine or the freestyle picker stores the plan it ran
  // (`target`), which is exactly a routine's exercise config: progression policy, per-side,
  // bodyweight and all. Reusing it keeps those settings instead of guessing them back.
  // `id` and `sg` are the routine's business, not the config's, and are set by the caller.
  if (target && typeof target === 'object') {
    const { id: _id, sg: _sg, ...cfg } = target
    return { ...cfg, sets: Math.max(1, Math.round(cfg.sets) || 1) }
  }

  // Imports and history older than `target` only have what was done. Read the plan off the
  // checked work sets; warm-ups and unchecked rows were never the plan.
  const id = entry && entry.id
  const work = ((entry && entry.sets) || []).filter(s => s && s.done && !isWarmupRow(s))
  const mode = modeForEntry({ id, sets: work }) || modeOf({ id })
  const cfg = defaultConfig(id, mode)
  if (!work.length) return cfg
  cfg.sets = work.length
  const most = key => Math.max(0, ...work.map(s => Number(s[key]) || 0))
  if (mode === 'cardio') {
    const last = work[work.length - 1]
    if (last.min > 0) cfg.min = last.min
    if (last.speed > 0) cfg.speed = last.speed
  } else if (mode === 'time') {
    if (most('sec') > 0) cfg.sec = most('sec')
  } else if (most('r') > 0) {
    cfg.reps = most('r')
  }
  // Weight stays at the default 0 on purpose. A set's `w` is in its own unit (`u`, else the
  // profile's) while a routine's weight is in the exercise's; the session seeds the load from
  // this very history through buildSets, which already converts, so nothing is lost.
  return cfg
}

/**
 * A new routine from the picked entries of a finished workout.
 * @param {object} w          a workout from S.workouts
 * @param {number[]} picked   entry indexes; order and duplicates do not matter
 * @param {{id: string, name?: string, emoji?: string}} opts
 */
export function routineFromWorkout(w, picked, { id, name, emoji } = {}) {
  const entries = (w && w.entries) || []
  const keep = new Set(picked)
  // Trained order, not tap order: that is the order the day was actually done in.
  const ex = entries.flatMap((entry, i) => {
    if (!keep.has(i)) return []
    const cfg = { id: entry.id, ...configFromEntry(entry) }
    const sg = entry.target && entry.target.sg
    if (sg) cfg.sg = sg
    return [cfg]
  })
  // A superset whose partner was left out is just an exercise.
  cleanupSg(ex)
  const routine = { id, name: (name || '').trim() || (w && w.name) || '', ex }
  if (emoji) routine.emoji = emoji
  return routine
}
