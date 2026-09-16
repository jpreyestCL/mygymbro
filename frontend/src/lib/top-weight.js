// The "confirm your working weight" sheet, as numbers.
//
// The sheet used to open on max(today's heaviest set, all-time best). That contradicted its own
// copy — "confirm the weight you worked with" — and it was not harmless: a Save without looking
// wrote the old record back as this session's `topW`, bestWeightForEntry then read that topW as
// the entry's best, and the next sheet proposed it again. One slip of the slider became a record
// nothing could lower. The proposal is what you lifted today; the record stays on the
// "previous best" line, and the exWeights ratchet keeps it without any help from the prefill.
//
// Everything here speaks the unit the exercise is logged in, because that is what the column
// above the sheet is headed in. A cable stack labelled in lb must not get a "9.2 kg" sheet.
import { baseUnit, unitForEx, wIn, wBase, convert } from './units.js'
import { bestWeightFor } from './history.js'
import { isWarmupRow } from './workout-model.js'

/** Heaviest completed work set of one entry, in `unit` (the profile's when omitted). */
export function sessionMax(S, entry, unit = baseUnit(S)) {
  const rows = (entry?.sets || []).filter(s => s?.done === true && !isWarmupRow(s))
  return Math.max(0, ...rows.map(s => wIn(S, s, unit)))
}

/**
 * An entry's confirmed working weight in the profile's unit. `topW` has no unit of its own:
 * it was confirmed beside the sets, so it reads in whatever unit they were logged in — the
 * same rule bestWeightForEntry applies, kept here so the finish path cannot drift from it.
 */
export function topWBase(S, entry) {
  if (entry?.topW == null) return 0
  const u = (entry.sets || []).find(x => x?.u)?.u
  return wBase(S, { w: entry.topW, u })
}

/**
 * What the sheet opens with, all in the exercise's unit:
 *   value    — the prefill: today's heaviest work set, else the planned weight
 *   maxSet   — today's heaviest work set (0 when nothing loaded was checked off)
 *   prevBest — the record before today: confirmed working weight or heaviest logged set
 *   record   — today beat it
 */
export function topWeightProposal(S, entry) {
  const unit = unitForEx(S, entry.id)
  const fromBase = base => convert(base || 0, baseUnit(S), unit)
  const maxSet = sessionMax(S, entry, unit)
  // Both candidates for the record are in the profile's unit: exWeights is written that way
  // (buildSets seeds from it as a base number) and bestWeightFor answers that way.
  const prevBest = fromBase(Math.max((S.exWeights?.[entry.id] || {}).w || 0, bestWeightFor(S, entry.id)))
  // A routine's planned weight is a profile-unit number too (see buildSets).
  const planned = fromBase(entry.target?.weight)
  return { unit, maxSet, prevBest, value: maxSet || planned || 0, record: maxSet > prevBest }
}

/** The number to keep in exWeights for a weight confirmed in the sheet's unit. */
export const confirmedBase = (S, entry, value) => convert(value, unitForEx(S, entry.id), baseUnit(S))
