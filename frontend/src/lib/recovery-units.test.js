// Recovery over a profile that logs in pounds, and over a history logged partly in each unit.
//
// This is the seam where the ported fatigue model meets this fork's per-set units, and it is
// silent when wrong: fatigue is a saturating curve, so a history read as kg when it was logged
// in lb does not throw or look obviously broken — every muscle just reads ~2.2x too fatigued
// and the map is quietly useless. recovery.js resolves a set's unit as
// `set.u ?? entry.target ?? entry ?? workout ?? opts.unit`, which is exactly this fork's rule
// ("`u` absent means the profile's unit", units.js), but only when the caller passes
// `opts.unit`. Forgetting that at a call site is the actual failure mode, so pin it here.
import { describe, expect, it } from 'vitest'
import { fatigueOf, strengthOf, LB_TO_KG } from './recovery.js'
import { wBase } from './units.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0)

// Barbell bench press — a catalogue id with real muscle metadata, so the map is non-empty.
const BENCH = '0025'

const workout = (start, sets) => ({
  start,
  d: new Date(start).toISOString().slice(0, 10),
  entries: [{ id: BENCH, sets }],
})

const reps = (w, u) => {
  const set = { w, r: 5, done: true }
  if (u) set.u = u
  return set
}

// The muscles bench press actually loads, so a comparison never comes down to 0 === 0.
const worked = map => Object.entries(map).filter(([, v]) => v > 0)

describe('fatigueOf with this fork’s units', () => {
  it('reads a pound profile as pounds, not as kilos', () => {
    // 225 lb ~ 102 kg. Read as kg it would be 225 kg — more than double the real load.
    const inLb = fatigueOf([workout(NOW - DAY, [reps(225)])], NOW, { unit: 'lb' })
    const asKgByMistake = fatigueOf([workout(NOW - DAY, [reps(225)])], NOW, { unit: 'kg' })

    expect(worked(inLb).length).toBeGreaterThan(0)
    for (const [slug, value] of worked(inLb)) {
      expect(value).toBeLessThan(asKgByMistake[slug])
    }
  })

  it('gives the same answer for one session expressed in either unit', () => {
    const kg = fatigueOf([workout(NOW - DAY, [reps(100)])], NOW, { unit: 'kg' })
    const lb = fatigueOf([workout(NOW - DAY, [reps(100 / LB_TO_KG)])], NOW, { unit: 'lb' })

    for (const [slug, value] of worked(kg)) {
      expect(lb[slug]).toBeCloseTo(value, 6)
    }
  })

  it('honours a per-set `u` stamp that disagrees with the profile', () => {
    // A kg profile, one set logged on lb dumbbells. 225 lb must not be read as 225 kg.
    const stamped = fatigueOf([workout(NOW - DAY, [reps(225, 'lb')])], NOW, { unit: 'kg' })
    const unstamped = fatigueOf([workout(NOW - DAY, [reps(225)])], NOW, { unit: 'kg' })

    for (const [slug, value] of worked(stamped)) {
      expect(value).toBeLessThan(unstamped[slug])
    }
    // …and it matches the same load written in the profile's own unit.
    const equivalent = fatigueOf([workout(NOW - DAY, [reps(225 * LB_TO_KG)])], NOW, { unit: 'kg' })
    for (const [slug, value] of worked(stamped)) {
      expect(value).toBeCloseTo(equivalent[slug], 6)
    }
  })

  it('agrees with wBase on what a stamped set weighs', () => {
    // The two unit readers must not drift: recovery.js has its own resolver (it is shared with
    // upstream), units.js has wBase. Same input, same kilos.
    const S = { unit: 'kg' }
    const set = { w: 225, u: 'lb', r: 5, done: true }
    expect(wBase(S, set)).toBeCloseTo(225 * LB_TO_KG, 2)

    const viaRecovery = fatigueOf([workout(NOW - DAY, [set])], NOW, { unit: 'kg' })
    const viaBase = fatigueOf([workout(NOW - DAY, [reps(wBase(S, set))])], NOW, { unit: 'kg' })
    for (const [slug, value] of worked(viaRecovery)) {
      expect(viaBase[slug]).toBeCloseTo(value, 4)
    }
  })

  it('leaves retained strength unit-independent — it reads dates, not loads', () => {
    const kg = strengthOf([workout(NOW - 40 * DAY, [reps(100)])], NOW, { unit: 'kg' })
    const lb = strengthOf([workout(NOW - 40 * DAY, [reps(220)])], NOW, { unit: 'lb' })
    expect(lb).toEqual(kg)
  })
})

describe('a history logged partly in each unit', () => {
  it('does not let an unstamped set inherit the previous set’s unit', () => {
    // Two sessions, one stamped lb, one plain. The plain one means the profile's unit and must
    // stay heavier — if the stamp leaked forward, the second session would shrink by 2.2x.
    const mixed = [
      workout(NOW - 3 * DAY, [reps(225, 'lb')]),
      workout(NOW - 1 * DAY, [reps(225)]),
    ]
    const bothPlain = [
      workout(NOW - 3 * DAY, [reps(225)]),
      workout(NOW - 1 * DAY, [reps(225)]),
    ]
    const mixedFatigue = fatigueOf(mixed, NOW, { unit: 'kg' })
    const plainFatigue = fatigueOf(bothPlain, NOW, { unit: 'kg' })

    expect(worked(mixedFatigue).length).toBeGreaterThan(0)
    for (const [slug, value] of worked(plainFatigue)) {
      expect(mixedFatigue[slug]).toBeLessThan(value)
    }
  })

  it('is stable when every set carries an explicit stamp', () => {
    // Same real load, written three ways. The map must not care which.
    const inKg = [workout(NOW - DAY, [reps(100, 'kg'), reps(100, 'kg')])]
    const inLb = [workout(NOW - DAY, [reps(100 / LB_TO_KG, 'lb'), reps(100 / LB_TO_KG, 'lb')])]
    const each = [workout(NOW - DAY, [reps(100, 'kg'), reps(100 / LB_TO_KG, 'lb')])]

    const a = fatigueOf(inKg, NOW, { unit: 'kg' })
    const b = fatigueOf(inLb, NOW, { unit: 'kg' })
    const c = fatigueOf(each, NOW, { unit: 'lb' })

    for (const [slug, value] of worked(a)) {
      expect(b[slug]).toBeCloseTo(value, 6)
      expect(c[slug]).toBeCloseTo(value, 6)
    }
  })
})
