import { describe, it, expect } from 'vitest'
import { EXDB, EXIDX, exOr } from './exercises.js'
import { EXDB as DATASET } from './exercises-data.js'
import { matchesQuery } from './exercise-search.js'

describe('fork additions to the catalogue', () => {
  it('extends the dataset without dropping or renaming any of its exercises', () => {
    expect(EXDB.length).toBeGreaterThan(DATASET.length)
    expect(EXDB.slice(0, DATASET.length)).toEqual(DATASET)
  })
  it('never reuses an id', () => {
    expect(new Set(EXDB.map(e => e.id)).size).toBe(EXDB.length)
  })
  it('has the hip thrust machine, resolvable and findable', () => {
    const ex = exOr('f0001')
    expect(ex.missing).toBeUndefined()
    expect(EXIDX.f0001).toBe(ex)
    expect(ex).toMatchObject({ bp: 'upper legs', eq: 'leverage machine', tg: 'glutes' })
    for (const q of ['hip thrust', 'booty builder', 'thrust machine']) {
      expect(EXDB.filter(e => matchesQuery(e, q)).map(e => e.id)).toContain('f0001')
    }
  })
})
