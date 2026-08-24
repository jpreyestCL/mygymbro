// The MCP layer over this fork's per-set units.
//
// Upstream openGym has one unit per profile, so its tools could hand raw `s.w` to the LLM.
// This fork stores the unit each set was logged in (`u`, absent meaning the profile's), which
// makes a raw `s.w` a number with no scale attached. An LLM cannot see that and will average
// 100 kg with 225 lb into "162.5 of something" — confidently, with no error anywhere. So the
// contract these tests pin is: every weight leaving the MCP server is already expressed in the
// profile's unit, and the payload names that unit.
import { describe, beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import { _seedStateForTests } from '../src/state.js'
import { TOOLS } from '../src/tools.js'
import { LB_TO_KG } from '../../frontend/src/lib/units.js'

const TODAY = '2026-07-27'
const BENCH = '0025'                 // barbell bench press
const byName = Object.fromEntries(TOOLS.map(t => [t.name, t.handler]))
const call = (name, params = {}) => byName[name](params)

// One session, one exercise, whatever sets the caller wants.
function stateWith(sets, unit = 'kg') {
  return {
    unit,
    routines: [], week: {}, dayPlan: {}, bodyweight: [], customEx: [], exWeights: {},
    workouts: [{
      id: 'w1', d: '2026-07-24', start: Date.parse('2026-07-24T10:00:00Z'), end: Date.parse('2026-07-24T11:00:00Z'),
      name: 'Push', entries: [{ id: BENCH, target: { sets: sets.length, reps: 5, weight: 100, mode: 'reps' }, sets }],
    }],
  }
}

const set = (w, r, extra = {}) => ({ w, r, done: true, ...extra })

beforeAll(() => { vi.useFakeTimers({ now: new Date(TODAY + 'T12:00:00Z'), toFake: ['Date'] }) })
afterAll(() => { vi.useRealTimers() })

describe('weights are normalised to the profile unit before they reach the LLM', () => {
  test('a set stamped lb on a kg profile is reported in kg', () => {
    _seedStateForTests(stateWith([set(225, 5, { u: 'lb' })], 'kg'))
    const w = call('get_workout', { date: '2026-07-24' })

    expect(w.unit).toBe('kg')
    const [row] = w.entries[0].sets
    expect(row.w).toBeCloseTo(225 * LB_TO_KG, 2)   // ~102.06, not 225
    expect(row.label).toContain('102')
  })

  test('an unstamped set means the profile unit and is passed through untouched', () => {
    _seedStateForTests(stateWith([set(100, 5)], 'kg'))
    const [row] = call('get_workout', { date: '2026-07-24' }).entries[0].sets
    expect(row.w).toBeCloseTo(100, 6)
  })

  test('volume never adds pounds to kilos', () => {
    // Same real load twice, written in different units. Volume must be 2 x 100 x 5 = 1000 kg,
    // not 100x5 + 220.46x5 = 1602.3.
    _seedStateForTests(stateWith([set(100, 5), set(100 / LB_TO_KG, 5, { u: 'lb' })], 'kg'))
    const w = call('get_workout', { date: '2026-07-24' })
    expect(w.volume).toBeCloseTo(1000, 1)
  })

  test('list_workouts reports the same normalised volume as get_workout', () => {
    _seedStateForTests(stateWith([set(100, 5), set(100 / LB_TO_KG, 5, { u: 'lb' })], 'kg'))
    const listed = call('list_workouts', {}).workouts[0]
    const detailed = call('get_workout', { date: '2026-07-24' })
    expect(listed.volume).toBeCloseTo(detailed.volume, 6)
  })

  test('a pound profile reports pounds, and converts a kg-stamped set into them', () => {
    _seedStateForTests(stateWith([set(100, 5, { u: 'kg' })], 'lb'))
    const w = call('get_workout', { date: '2026-07-24' })
    expect(w.unit).toBe('lb')
    expect(w.entries[0].sets[0].w).toBeCloseTo(100 / LB_TO_KG, 1)   // ~220.46
  })
})

describe('estimated 1RM over a mixed-unit history', () => {
  test('estimate_1rm answers in the profile unit', () => {
    _seedStateForTests(stateWith([set(225, 5, { u: 'lb' })], 'kg'))
    const out = call('estimate_1rm', { exercise_id: BENCH })
    // Epley on 102.06 kg x 5 is ~119, not the ~262 a raw 225 would give.
    expect(out.best.est).toBeGreaterThan(100)
    expect(out.best.est).toBeLessThan(140)
  })

  test('the same lift written either way gives the same estimate', () => {
    _seedStateForTests(stateWith([set(100, 5)], 'kg'))
    const kg = call('estimate_1rm', { exercise_id: BENCH }).best.est
    _seedStateForTests(stateWith([set(100 / LB_TO_KG, 5, { u: 'lb' })], 'kg'))
    const lb = call('estimate_1rm', { exercise_id: BENCH }).best.est
    expect(lb).toBeCloseTo(kg, 1)
  })

  test('a warm-up row never wins the estimate', () => {
    // 60 x 12 (warm-up) Epley-estimates higher than 100 x 3. Counting it would report a 1RM
    // the lifter has never been near, off a set they did to warm up.
    _seedStateForTests(stateWith([
      set(60, 12, { phase: 'warmup' }),
      set(100, 3),
    ], 'kg'))
    const out = call('estimate_1rm', { exercise_id: BENCH })
    expect(out.best.w).toBeCloseTo(100, 6)
    expect(out.best.r).toBe(3)
  })

  test('the legacy warmup boolean counts too', () => {
    _seedStateForTests(stateWith([
      set(60, 12, { warmup: true }),
      set(100, 3),
    ], 'kg'))
    expect(call('estimate_1rm', { exercise_id: BENCH }).best.w).toBeCloseTo(100, 6)
  })
})

describe('set rows carry their phase', () => {
  test('warmup is reported so the LLM can exclude it from working volume', () => {
    _seedStateForTests(stateWith([set(60, 12, { phase: 'warmup' }), set(100, 3)], 'kg'))
    const rows = call('get_workout', { date: '2026-07-24' }).entries[0].sets
    expect(rows.map(r => r.warmup)).toEqual([true, false])
  })
})
