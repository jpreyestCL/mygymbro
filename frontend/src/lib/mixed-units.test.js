// A history logged partly in lb and partly in kg has to read as one history. Every helper
// that compares or adds up sets gets checked here, because the failure mode is silent: no
// error, just a volume chart, a PR and a next-session target that are all quietly wrong.
import { describe, it, expect } from 'vitest'
import { workoutVolume, bestWeightFor, buildSets, setLabelIn } from './history.js'
import { bestSetOf, best1RM } from './onerm.js'
import { readSession, nextPrescription } from './progression.js'

// 135 lb = 61.23 kg — heavier than the 60 kg set, though the bare number is smaller.
const LB_SET = { w: 135, r: 5, u: 'lb', done: true }
const KG_SET = { w: 60, r: 5, done: true }

const S = (over = {}) => ({
  unit: 'kg', exUnit: {}, exWeights: {}, workouts: [], routines: [], ...over,
})
const workout = (d, sets) => ({ d, entries: [{ id: 'X', sets }] })

describe('volume', () => {
  it('adds lb and kg sets in one unit', () => {
    const w = workout('2026-01-01', [LB_SET, KG_SET])
    expect(workoutVolume(w, S())).toBe(61.23 * 5 + 60 * 5)
  })
  it('without a profile it stays the old bare-number sum — no silent behaviour change', () => {
    const w = workout('2026-01-01', [KG_SET])
    expect(workoutVolume(w)).toBe(300)
  })
  it('counts only completed sets, as before', () => {
    const w = workout('2026-01-01', [{ ...LB_SET, done: false }])
    expect(workoutVolume(w, S())).toBe(0)
  })
})

describe('best weight', () => {
  it('picks the genuinely heavier set, not the bigger number', () => {
    const s = S({ workouts: [workout('2026-01-01', [KG_SET]), workout('2026-01-08', [LB_SET])] })
    expect(bestWeightFor(s, 'X')).toBe(61.23)
  })
  it('reads a confirmed working weight in the unit its entry was logged in', () => {
    const s = S({ workouts: [{ d: '2026-01-01', entries: [{ id: 'X', sets: [LB_SET], topW: 140 }] }] })
    expect(bestWeightFor(s, 'X')).toBeCloseTo(63.5, 1)   // 140 lb, not 140 kg
  })
})

describe('1RM', () => {
  it('estimates from the load actually lifted', () => {
    const inLb = bestSetOf({ sets: [LB_SET] }, 'epley', S())
    const inKg = bestSetOf({ sets: [KG_SET] }, 'epley', S())
    expect(inLb.est).toBeGreaterThan(inKg.est)
  })
  it('a lb session does not fake a record against a heavier kg one', () => {
    // 135 lb (61.2 kg) after 70 kg is not a PR, even though 135 > 70.
    const s = S({ workouts: [
      workout('2026-01-01', [{ w: 70, r: 5, done: true }]),
      workout('2026-01-08', [LB_SET]),
    ] })
    expect(best1RM(s, 'X').w).toBe(70)
  })
})

describe('progression', () => {
  it('reads a session’s working weight in the profile’s unit', () => {
    const entry = { id: 'X', target: { sets: 1, reps: 5 }, sets: [LB_SET] }
    expect(readSession(entry, null, S()).weight).toBe(61.23)
  })
  it('still reads a bare number when no profile is passed', () => {
    const entry = { id: 'X', target: { sets: 1, reps: 5 }, sets: [LB_SET] }
    expect(readSession(entry, null).weight).toBe(135)
  })
})

describe('next session’s rows', () => {
  it('carries last time’s lb weight over as kg when the exercise now logs kg', () => {
    const s = S({ workouts: [workout('2026-01-01', [LB_SET])] })
    const sets = buildSets(s, { id: 'X', sets: 1, reps: 5, weight: 0 })
    expect(sets[0].w).toBe(61.23)
    expect('u' in sets[0]).toBe(false)      // profile unit — nothing to stamp
  })
  it('carries a kg history over as lb when the exercise is switched to lb', () => {
    const s = S({ exUnit: { X: 'lb' }, workouts: [workout('2026-01-01', [KG_SET])] })
    const sets = buildSets(s, { id: 'X', sets: 1, reps: 5, weight: 0 })
    expect(sets[0].w).toBeCloseTo(132.28, 1)
    expect(sets[0].u).toBe('lb')
  })
})

describe('labels', () => {
  it('shows an lb set on a kg screen', () => {
    expect(setLabelIn(S(), 'X', LB_SET, { mode: 'reps' }, 'kg')).toBe('61.2×5')
  })
  it('shows a kg set on an lb screen', () => {
    expect(setLabelIn(S(), 'X', KG_SET, { mode: 'reps' }, 'lb')).toBe('132.3×5')
  })
})

describe('prescription unit', () => {
  const history = d => ({ d, entries: [{ id: 'X', target: { sets: 3, reps: 5, weight: 60 }, sets: [
    { w: 60, r: 5, done: true }, { w: 60, r: 5, done: true }, { w: 60, r: 5, done: true },
  ] }] })
  const cfg = { id: 'X', sets: 3, reps: 5, weight: 60, mode: 'reps', policy: 'linear' }

  it('prescribes in kg for a kg exercise', () => {
    const s = S({ workouts: [history('2026-01-01')] })
    const p = nextPrescription(s, cfg, null)
    expect(p.kind).toBe('up')
    expect(p.weight).toBe(62.5)                 // 60 + 2.5 kg
    expect(p.why).toContain('kg')
  })

  it('prescribes in lb — and in lb-sized steps — once the exercise is switched to lb', () => {
    const s = S({ exUnit: { X: 'lb' }, workouts: [history('2026-01-01')] })
    const p = nextPrescription(s, cfg, null)
    expect(p.kind).toBe('up')
    // 60 kg is 132.3 lb; a linear jump in lb is 5, not 2.5.
    expect(p.weight).toBeGreaterThan(132)
    expect(p.weight).toBeLessThan(140)
    expect(p.why).toContain('lb')
    expect(p.why).not.toContain('kg')
  })
})
