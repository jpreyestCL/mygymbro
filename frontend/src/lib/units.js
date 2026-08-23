// Weight units, per exercise (issue: log in the unit the equipment is labelled in).
//
// Until now a set stored a bare number and the profile's `unit` was only a label — Settings
// said so out loud. That works right up until one gym's dumbbells are in lb and the plates
// next door are in kg: you either do arithmetic in your head or your history lies.
//
// So a set now carries the unit it was logged in, and only when that differs from the
// profile's — `u` absent reads as the profile's unit, which is exactly what every set
// written before this existed meant. Nothing needs migrating.
//
// Two different questions get two different helpers, and mixing them up is the bug this
// splits apart:
//   wIn(S, set, unit)  — what to SHOW. The number in the unit the screen is speaking.
//   wBase(S, set)      — what to COMPARE. Every set in one unit (the profile's), so volume,
//                        PRs, 1RM estimates and progression never add lb to kg.

export const UNITS = ['kg', 'lb']
export const LB_TO_KG = 0.45359237

// Two decimals, not one: at one decimal a 135 lb bar comes back as 134.9 after a round
// trip, and a user who taps the toggle a few times watches their working weight drift.
// Display rounding stays where it belongs, in fmtNum.
const clean = n => Math.round((Number(n) || 0) * 100) / 100

/** Convert between kg and lb. Same unit in and out is a no-op, not a rounding pass. */
export function convert(w, from, to) {
  const n = Number(w) || 0
  if (!n || from === to || !from || !to) return n
  return clean(from === 'lb' ? n * LB_TO_KG : n / LB_TO_KG)
}

// Smallest plate change worth typing in each unit. Snapping a converted weight to it is
// what makes the toggle round-trip exactly (135 lb -> 61.25 kg -> 135 lb) instead of
// creeping, and it lands on numbers you can actually load.
const STEP = { kg: 0.25, lb: 0.5 }
export const snapTo = (w, unit) => {
  const st = STEP[unit] || 0.25
  return Math.round(Math.round((Number(w) || 0) / st) * st * 100) / 100
}

/** The profile's unit — the one a bare number is in. */
export const baseUnit = S => (UNITS.includes(S?.unit) ? S.unit : 'kg')

/**
 * The unit an exercise is logged in. Set per exercise from the workout screen and
 * remembered, because a machine does not change which unit it is labelled in between
 * sessions. Unset means "whatever the profile uses".
 */
export const unitForEx = (S, exId) => {
  const u = S?.exUnit?.[exId]
  return UNITS.includes(u) ? u : baseUnit(S)
}

/** The unit one stored set is in. Absent `u` means the profile's — see the header. */
export const setUnit = (S, set) => (UNITS.includes(set?.u) ? set.u : baseUnit(S))

/** A set's weight expressed in `to`. For display. */
export const wIn = (S, set, to) => convert(set?.w || 0, setUnit(S, set), to || baseUnit(S))

/** A set's weight in the profile's unit. For anything that compares or adds up sets. */
export const wBase = (S, set) => wIn(S, set, baseUnit(S))

/**
 * Stamp `u` on a set for `unit`, dropping the key when it matches the profile so the
 * common case stays byte-for-byte what it was before units existed.
 */
export function markUnit(S, set, unit) {
  if (unit === baseUnit(S)) delete set.u
  else set.u = unit
  return set
}

/**
 * Re-express a set in `to`, converting the number so it stays the same physical load.
 * Switching a set of 27 kg to lb must show 59.5, not 27 with a new label.
 */
export function reexpress(S, set, to) {
  if (set && set.w) set.w = snapTo(wIn(S, set, to), to)
  return markUnit(S, set || {}, to)
}
