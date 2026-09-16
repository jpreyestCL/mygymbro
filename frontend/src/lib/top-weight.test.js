// The sheet that closes an exercise proposes what you lifted today, in the unit you lifted it
// in. Both halves matter: proposing the old record wrote it back as today's working weight on
// a careless Save, and a bare max over set.w put a lb number under a kg label.
import { describe, it, expect } from 'vitest'
import { topWeightProposal, sessionMax, topWBase, confirmedBase, nextDefault } from './top-weight.js'

const S = (over = {}) => ({ unit: 'kg', exUnit: {}, exWeights: {}, workouts: [], routines: [], ...over })
const kg = (w, r = 10) => ({ w, r, done: true })
const lb = (w, r = 10) => ({ w, r, u: 'lb', done: true })
const past = (d, sets, extra = {}) => ({ d, entries: [{ id: 'X', sets, ...extra }] })

describe('what the sheet proposes', () => {
  it("is today's heaviest set, not the record", () => {
    // The screenshot that started this: sets of 11.3–13.6 kg under a 46 kg "previous best".
    const s = S({ workouts: [past('2026-01-01', [kg(20)])], exWeights: { X: { w: 46, d: '2026-01-01' } } })
    const p = topWeightProposal(s, { id: 'X', sets: [kg(11.3, 15), kg(13.6, 10), kg(13.6, 9), kg(13.6, 8)] })
    expect(p.value).toBe(13.6)
    expect(p.maxSet).toBe(13.6)
    expect(p.prevBest).toBe(20)
    expect(p.record).toBe(false)
    expect(p.unit).toBe('kg')
  })
  it('"previous best" is what was lifted, never the next-time default or an inflated topW', () => {
    // 46 got into exWeights and into a past entry's topW by the old prefill; the sets say 13.6.
    const s = S({ workouts: [past('2026-01-01', [kg(13.6)], { topW: 46 })], exWeights: { X: { w: 46, d: '2026-01-01' } } })
    const p = topWeightProposal(s, { id: 'X', sets: [kg(15)] })
    expect(p.prevBest).toBe(13.6)
    expect(p.record).toBe(true)
  })
  it('flags a record when today is heavier than anything before', () => {
    const s = S({ workouts: [{ d: '2026-01-01', entries: [{ id: 'X', sets: [kg(50)] }] }] })
    const p = topWeightProposal(s, { id: 'X', sets: [kg(52.5)] })
    expect(p.value).toBe(52.5)
    expect(p.prevBest).toBe(50)
    expect(p.record).toBe(true)
  })
  it('ignores unchecked sets and warm-ups', () => {
    const p = topWeightProposal(S(), { id: 'X', sets: [{ w: 40, r: 8, done: true, phase: 'warmup' }, kg(30), { w: 60, r: 5, done: false }] })
    expect(p.value).toBe(30)
  })
  it('falls back to the planned weight when nothing loaded was checked off', () => {
    const p = topWeightProposal(S(), { id: 'X', target: { weight: 20 }, sets: [{ w: 20, r: 8, done: false }] })
    expect(p.value).toBe(20)
    expect(p.maxSet).toBe(0)
  })
  it('the fallback follows the exercise unit too', () => {
    const p = topWeightProposal(S({ exUnit: { X: 'lb' } }), { id: 'X', target: { weight: 20 }, sets: [] })
    expect(p.unit).toBe('lb')
    expect(p.value).toBeCloseTo(44.09, 1)
  })
})

describe('an exercise logged in lb on a kg profile', () => {
  const s = S({ exUnit: { X: 'lb' }, workouts: [past('2026-01-01', [kg(46)])] })
  const entry = { id: 'X', sets: [lb(25, 15), lb(30, 10)] }
  it('speaks lb throughout — the column above the sheet is headed lb', () => {
    const p = topWeightProposal(s, entry)
    expect(p.unit).toBe('lb')
    expect(p.value).toBe(30)                 // the number on the row, not 13.6
    expect(p.prevBest).toBeCloseTo(101.4, 1) // 46 kg shown in lb
    expect(p.record).toBe(false)
  })
  it('compares the record in one unit: 30 lb is not heavier than 46 kg', () => {
    expect(topWeightProposal(s, entry).record).toBe(false)
    // …but 110 lb is.
    expect(topWeightProposal(s, { id: 'X', sets: [lb(110)] }).record).toBe(true)
  })
  it('keeps the confirmed weight in the profile unit, which is how buildSets reads exWeights', () => {
    expect(confirmedBase(s, entry, 30)).toBeCloseTo(13.61, 2)
    expect(confirmedBase(S(), entry, 30)).toBe(30)
  })
})

describe('the finish path reads the same numbers', () => {
  it('sessionMax normalises to the profile unit by default', () => {
    expect(sessionMax(S(), { sets: [lb(135), kg(60)] })).toBe(61.23)
    expect(sessionMax(S(), { sets: [lb(135), kg(60)] }, 'lb')).toBeCloseTo(135, 1)
  })
  it('topW reads in the unit its sets were logged in, like bestWeightForEntry', () => {
    expect(topWBase(S(), { topW: 140, sets: [lb(135)] })).toBeCloseTo(63.5, 1)
    expect(topWBase(S(), { topW: 60, sets: [kg(55)] })).toBe(60)
    expect(topWBase(S(), { sets: [kg(55)] })).toBe(0)
  })
})

describe('what the next session opens on (exWeights)', () => {
  it('a confirmed weight sets it, lower included — no ratchet', () => {
    expect(nextDefault(S(), { topW: 13.6, sets: [kg(13.6)] }, 46)).toBe(13.6)
    expect(nextDefault(S(), { topW: 50, sets: [kg(45)] }, 40)).toBe(50)
  })
  it('a confirmed weight is stored in the profile unit', () => {
    expect(nextDefault(S(), { topW: 30, sets: [lb(30)] }, 46)).toBeCloseTo(13.61, 2)
  })
  it('an unconfirmed session only raises it, as before', () => {
    expect(nextDefault(S(), { sets: [kg(50)] }, 40)).toBe(50)
    expect(nextDefault(S(), { sets: [kg(30)] }, 40)).toBe(40)
    expect(nextDefault(S(), { sets: [kg(30)] }, undefined)).toBe(30)
  })
  it('an unloaded, unconfirmed session leaves nothing to store', () => {
    expect(nextDefault(S(), { sets: [{ r: 10, done: true }] }, undefined)).toBe(0)
  })
})
