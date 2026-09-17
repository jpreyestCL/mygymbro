import { describe, it, expect } from 'vitest'
import { routineFromWorkout, configFromEntry } from './routine-from-workout.js'
import { EXDB } from './exercises.js'

const LIFT = EXDB.find(e => e.bp !== 'cardio' && e.eq !== 'body weight').id
const BW = EXDB.find(e => e.bp !== 'cardio' && e.eq === 'body weight').id
const CARDIO = EXDB.find(e => e.bp === 'cardio').id

const set = (r, w, extra = {}) => ({ r, w, done: true, ...extra })

describe('configFromEntry', () => {
  it('keeps the plan the session was run from, minus the id it rides next to', () => {
    const target = { id: LIFT, sets: 4, mode: 'reps', reps: 8, weight: 60, policy: 'double', repsMin: 6 }
    expect(configFromEntry({ id: LIFT, target, sets: [set(8, 60)] }))
      .toEqual({ sets: 4, mode: 'reps', reps: 8, weight: 60, policy: 'double', repsMin: 6 })
  })

  it('copies the target instead of sharing it, so editing the routine never rewrites history', () => {
    const target = { sets: 3, reps: 10, weight: 20, mode: 'reps' }
    const cfg = configFromEntry({ id: LIFT, target, sets: [] })
    cfg.reps = 99
    expect(target.reps).toBe(10)
  })

  it('reads a workout with no target (imports, pre-target history) off the sets actually done', () => {
    const cfg = configFromEntry({ id: LIFT, sets: [
      set(5, 40, { warmup: true }), set(10, 60), set(8, 60), set(12, 60, { done: false }),
    ] })
    // Warm-ups and unchecked rows are not part of the plan; the best rep count done is.
    expect(cfg).toMatchObject({ mode: 'reps', sets: 2, reps: 10 })
  })

  it('leaves weight at 0 when it has to derive one, so no set is read in the wrong unit', () => {
    // A set without `u` is in the profile's unit and a routine's weight is in the exercise's;
    // 0 lets the session seed the load from history, which already converts correctly.
    expect(configFromEntry({ id: LIFT, sets: [set(10, 225, { u: 'lb' })] }).weight).toBe(0)
  })

  it('derives timed and cardio sessions in their own terms', () => {
    expect(configFromEntry({ id: LIFT, sets: [{ sec: 30, done: true }, { sec: 45, done: true }], target: null }))
      .toMatchObject({ sets: 2, sec: 45, mode: 'time', weight: 0 })
    expect(configFromEntry({ id: CARDIO, sets: [{ min: 25, speed: 9, done: true }] }))
      .toEqual({ sets: 1, min: 25, speed: 9 })
  })

  it('keeps the bodyweight default for bodyweight exercises', () => {
    expect(configFromEntry({ id: BW, sets: [set(15, 0)] })).toMatchObject({ bodyweight: true, reps: 15 })
  })

  it('never writes a zero-set plan', () => {
    expect(configFromEntry({ id: LIFT, sets: [] }).sets).toBe(3)
    expect(configFromEntry({ id: LIFT, target: { sets: 0, reps: 10, mode: 'reps' }, sets: [set(10, 20)] }).sets).toBe(1)
  })
})

describe('routineFromWorkout', () => {
  const w = {
    id: 'w1', name: 'Push day', d: '2026-09-10',
    entries: [
      { id: LIFT, target: { id: LIFT, sg: 'sgA', sets: 3, reps: 10, weight: 50, mode: 'reps' }, sets: [set(10, 50)] },
      { id: BW, target: { id: BW, sg: 'sgA', sets: 3, reps: 12, weight: 0, mode: 'reps', bodyweight: true }, sets: [set(12, 0)] },
      { id: CARDIO, target: { sets: 1, min: 20, speed: 8 }, sets: [{ min: 20, speed: 8, done: true }] },
    ],
  }

  it('builds a routine from the picked exercises, in the order they were trained', () => {
    const r = routineFromWorkout(w, [2, 0], { id: 'r1', name: 'Legs', emoji: 'dumbbell' })
    expect(r).toEqual({
      id: 'r1', name: 'Legs', emoji: 'dumbbell',
      ex: [{ id: LIFT, sets: 3, reps: 10, weight: 50, mode: 'reps' }, { id: CARDIO, sets: 1, min: 20, speed: 8 }],
    })
  })

  it('keeps a superset only when both partners were picked', () => {
    expect(routineFromWorkout(w, [0, 1], { id: 'r' }).ex.map(e => e.sg)).toEqual(['sgA', 'sgA'])
    expect(routineFromWorkout(w, [0], { id: 'r' }).ex[0].sg).toBeUndefined()
  })

  it('falls back to the workout name when none is given', () => {
    expect(routineFromWorkout(w, [0], { id: 'r', name: '   ' }).name).toBe('Push day')
  })

  it('ignores indexes that do not exist and picks nothing twice', () => {
    expect(routineFromWorkout(w, [0, 0, 7, -1], { id: 'r' }).ex).toHaveLength(1)
  })
})
