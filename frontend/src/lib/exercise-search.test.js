import { describe, it, expect } from 'vitest'
import { matchesQuery, queryWords, rankByUsage } from './exercise-search.js'

const ex = (id, n, over = {}) => ({ id, n, bp: 'back', tg: 'lats', eq: 'cable', desc: '', ...over })
const CABLE_ROW = ex('cr', 'Cable Row')
const DB_CURL = ex('dc', 'Dumbbell Curl', { bp: 'upper arms', tg: 'biceps', eq: 'dumbbell' })

describe('matching', () => {
  it('finds the words in any order', () => {
    expect(matchesQuery(CABLE_ROW, 'row cable')).toBe(true)
    expect(matchesQuery(CABLE_ROW, 'cable row')).toBe(true)
  })
  it('requires every word, not any', () => {
    expect(matchesQuery(CABLE_ROW, 'cable curl')).toBe(false)
    expect(matchesQuery(DB_CURL, 'db curl')).toBe(false)
  })
  it('a word may match a different field than the others', () => {
    // "biceps" is the target, "dumbbell" the equipment, "curl" the name.
    expect(matchesQuery(DB_CURL, 'biceps dumbbell curl')).toBe(true)
  })
  it('is case-insensitive and ignores stray whitespace', () => {
    expect(matchesQuery(CABLE_ROW, '  ROW   Cable ')).toBe(true)
    expect(queryWords('  ROW   Cable ')).toEqual(['row', 'cable'])
  })
  it('a blank query matches everything', () => {
    expect(matchesQuery(CABLE_ROW, '')).toBe(true)
    expect(matchesQuery(CABLE_ROW, '   ')).toBe(true)
  })
  it('still contains-matches inside a word, as the single-string search did', () => {
    expect(matchesQuery(CABLE_ROW, 'ow cab')).toBe(true)
  })
  it('tolerates a missing description', () => {
    expect(matchesQuery({ id: 'x', n: 'Plank', tg: 'abs', eq: 'body weight' }, 'plank abs')).toBe(true)
  })
})

describe('ordering', () => {
  const a = ex('a', 'Alpha'), b = ex('b', 'Bravo'), c = ex('c', 'Charlie'), d = ex('d', 'Delta')
  it('puts the exercises you have done first, most-used at the top', () => {
    const out = rankByUsage([a, b, c, d], { b: 1, d: 3 })
    expect(out.map(e => e.id)).toEqual(['d', 'b', 'a', 'c'])
  })
  it('breaks a usage tie by name', () => {
    const out = rankByUsage([c, a, b], { a: 2, b: 2, c: 2 })
    expect(out.map(e => e.id)).toEqual(['a', 'b', 'c'])
  })
  it('keeps the never-used tail in the order it came', () => {
    const out = rankByUsage([d, c, b, a], {})
    expect(out.map(e => e.id)).toEqual(['d', 'c', 'b', 'a'])
  })
  it('survives no usage map at all', () => {
    expect(rankByUsage([a, b]).map(e => e.id)).toEqual(['a', 'b'])
  })
})
