import { describe, it, expect } from 'vitest'
import { convert, baseUnit, unitForEx, setUnit, wIn, wBase, markUnit, reexpress, snapTo } from './units.js'

const S = (over = {}) => ({ unit: 'kg', exUnit: {}, ...over })

describe('convert', () => {
  it('converts both ways', () => {
    expect(convert(100, 'lb', 'kg')).toBe(45.36)
    expect(convert(100, 'kg', 'lb')).toBe(220.46)
  })
  it('leaves a same-unit value untouched, including its decimals', () => {
    expect(convert(27.25, 'kg', 'kg')).toBe(27.25)
  })
  // convert() alone is lossy by a rounding step — exact round-tripping is snapTo's job,
  // and reexpress() (what the toggle actually calls) composes the two. See below.
  it('round-trips within a rounding step', () => {
    expect(convert(convert(27, 'kg', 'lb'), 'lb', 'kg')).toBeCloseTo(27, 1)
    expect(convert(convert(135, 'lb', 'kg'), 'kg', 'lb')).toBeCloseTo(135, 1)
  })
  it('snaps to a weight you can actually load', () => {
    expect(snapTo(61.23, 'kg')).toBe(61.25)
    expect(snapTo(59.52, 'lb')).toBe(59.5)
  })
  it('treats a missing or zero weight as nothing to convert', () => {
    expect(convert(0, 'kg', 'lb')).toBe(0)
    expect(convert(undefined, 'kg', 'lb')).toBe(0)
  })
})

describe('which unit a set is in', () => {
  it('reads a set with no unit as the profile’s — every set logged before this existed', () => {
    expect(setUnit(S(), { w: 60, r: 5 })).toBe('kg')
    expect(setUnit(S({ unit: 'lb' }), { w: 135, r: 5 })).toBe('lb')
  })
  it('honours an explicit unit over the profile’s', () => {
    expect(setUnit(S(), { w: 135, u: 'lb' })).toBe('lb')
  })
  it('falls back to kg when the profile’s unit is missing or junk', () => {
    expect(baseUnit({})).toBe('kg')
    expect(baseUnit({ unit: 'stone' })).toBe('kg')
  })
})

describe('unitForEx', () => {
  it('defaults to the profile’s unit', () => {
    expect(unitForEx(S(), '0001')).toBe('kg')
  })
  it('remembers a per-exercise choice', () => {
    expect(unitForEx(S({ exUnit: { '0001': 'lb' } }), '0001')).toBe('lb')
  })
  it('does not leak one exercise’s choice onto another', () => {
    const s = S({ exUnit: { '0001': 'lb' } })
    expect(unitForEx(s, '0002')).toBe('kg')
  })
})

describe('display vs comparison', () => {
  const s = S()
  const inLb = { w: 135, r: 5, u: 'lb' }
  const inKg = { w: 60, r: 5 }

  it('shows an lb set in kg when the screen speaks kg', () => {
    expect(wIn(s, inLb, 'kg')).toBe(61.23)
  })
  it('shows a kg set in lb when the screen speaks lb', () => {
    expect(wIn(s, inKg, 'lb')).toBe(132.28)
  })
  it('normalises everything to the profile’s unit for comparison', () => {
    expect(wBase(s, inLb)).toBe(61.23)
    expect(wBase(s, inKg)).toBe(60)
  })
  it('ranks a mixed-unit history by real load, not by the bare number', () => {
    // 135 lb (61.2 kg) is heavier than 60 kg, even though 60 < 135.
    expect(wBase(s, inLb)).toBeGreaterThan(wBase(s, inKg))
  })
})

describe('markUnit', () => {
  it('drops the key when the set matches the profile, keeping old files byte-identical', () => {
    const set = markUnit(S(), { w: 60, u: 'lb' }, 'kg')
    expect('u' in set).toBe(false)
  })
  it('writes the key only when it differs', () => {
    expect(markUnit(S(), { w: 60 }, 'lb').u).toBe('lb')
  })
})

describe('reexpress', () => {
  it('keeps the same physical load when switching a set’s unit', () => {
    const set = reexpress(S(), { w: 27, r: 10 }, 'lb')
    expect(set).toEqual({ w: 59.5, r: 10, u: 'lb' })
  })
  it('switching back returns the original number, however many times it is toggled', () => {
    let set = { w: 27, r: 10 }
    for (let i = 0; i < 6; i++) {
      set = reexpress(S(), set, 'lb')
      expect(set.w).toBe(59.5)
      set = reexpress(S(), set, 'kg')
      expect(set.w).toBe(27)
    }
    expect('u' in set).toBe(false)
  })
  it('leaves a bodyweight set alone but still records the unit it was logged in', () => {
    const set = reexpress(S(), { w: 0, r: 12 }, 'lb')
    expect(set.w).toBe(0)
    expect(set.u).toBe('lb')
  })
})
