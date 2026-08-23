import { describe, it, expect } from 'vitest'
import { mondayOf, weekDays, monthGrid, yearMonths, periodLabel } from './calendar.js'

// Local noon, matching how the module builds its dates.
const on = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0, 0)
const t = (s, ...a) => a.reduce((v, x, i) => v.replaceAll(`{${i}}`, x), s)

describe('mondayOf', () => {
  it('finds the Monday of a mid-week day', () => {
    expect(mondayOf(on(2026, 8, 20)).getDate()).toBe(17)      // Thu 20 Aug -> Mon 17
  })
  it('treats Sunday as the END of its week, not the start', () => {
    // The bug this guards: getDay() calls Sunday 0, so a naive week starts the day AFTER.
    expect(mondayOf(on(2026, 8, 23)).getDate()).toBe(17)      // Sun 23 Aug -> Mon 17
  })
  it('leaves a Monday where it is', () => {
    expect(mondayOf(on(2026, 8, 17)).getDate()).toBe(17)
  })
  it('steps whole weeks and crosses a month boundary', () => {
    expect(mondayOf(on(2026, 8, 5), -1).getDate()).toBe(27)   // back into July
    expect(mondayOf(on(2026, 8, 5), 1).getDate()).toBe(10)
  })
})

describe('weekDays', () => {
  const d = weekDays(on(2026, 8, 20))
  it('returns seven days, Monday first, Sunday last', () => {
    expect(d).toHaveLength(7)
    expect(d[0].dow).toBe(1)
    expect(d[6].dow).toBe(0)
  })
  it('is contiguous', () => {
    expect(d.map(x => x.day)).toEqual([17, 18, 19, 20, 21, 22, 23])
  })
})

describe('monthGrid', () => {
  it('covers whole weeks, so the columns line up', () => {
    const { days } = monthGrid(on(2026, 8, 20))
    expect(days.length % 7).toBe(0)
  })
  it('contains every day of the month exactly once', () => {
    const { days } = monthGrid(on(2026, 8, 20))
    const inMonth = days.filter(x => !x.out).map(x => x.day)
    expect(inMonth).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
  })
  it('flags the neighbouring days it pads with', () => {
    const { days } = monthGrid(on(2026, 8, 20))
    expect(days[0].out).toBe(true)              // Aug 2026 starts on a Saturday
    expect(days.filter(x => x.out).length).toBeGreaterThan(0)
  })
  it('handles a leap February', () => {
    const { days } = monthGrid(on(2024, 2, 10))
    expect(days.filter(x => !x.out)).toHaveLength(29)
  })
  it('handles a non-leap February that starts on a Monday — the shortest possible grid', () => {
    const { days } = monthGrid(on(2021, 2, 10))
    expect(days.filter(x => !x.out)).toHaveLength(28)
    expect(days).toHaveLength(28)                // exactly four weeks, no padding at all
  })
  it('handles a 31-day month starting on a Sunday, which needs six rows', () => {
    const { days } = monthGrid(on(2026, 3, 10))  // March 2026 starts Sunday
    expect(days.filter(x => !x.out)).toHaveLength(31)
    expect(days).toHaveLength(42)
  })
  it('steps to the previous and next month, wrapping the year', () => {
    expect(monthGrid(on(2026, 1, 15), -1).month).toBe(11)
    expect(monthGrid(on(2026, 1, 15), -1).year).toBe(2025)
    expect(monthGrid(on(2026, 12, 15), 1).month).toBe(0)
    expect(monthGrid(on(2026, 12, 15), 1).year).toBe(2027)
  })
})

describe('yearMonths', () => {
  const y = yearMonths(on(2026, 8, 20))
  it('returns twelve months', () => {
    expect(y).toHaveLength(12)
  })
  it('spans each month from its first day to its last', () => {
    expect(y[0].from).toBe('2026-01-01')
    expect(y[0].to).toBe('2026-01-31')
    expect(y[1].to).toBe('2026-02-28')
    expect(y[11].to).toBe('2026-12-31')
  })
  it('gets February right in a leap year', () => {
    expect(yearMonths(on(2024, 5, 1))[1].to).toBe('2024-02-29')
  })
  it('steps years', () => {
    expect(yearMonths(on(2026, 8, 20), -1)[0].from).toBe('2025-01-01')
  })
})

describe('periodLabel', () => {
  const from = on(2026, 8, 20)
  it('names the current period instead of dating it', () => {
    expect(periodLabel('week', from, 0, t, 'en-GB')).toBe('This week')
    expect(periodLabel('month', from, 0, t, 'en-GB')).toBe('This month')
    expect(periodLabel('year', from, 0, t, 'en-GB')).toBe('This year')
  })
  it('dates any other week', () => {
    expect(periodLabel('week', from, -1, t, 'en-GB')).toBe('10 Aug – 16 Aug')
  })
  it('omits the year for another month of this year, and shows it otherwise', () => {
    expect(periodLabel('month', from, -1, t, 'en-GB')).toBe('July')
    expect(periodLabel('month', from, -8, t, 'en-GB')).toBe('December 2025')
  })
  it('is just the year for another year', () => {
    expect(periodLabel('year', from, -1, t, 'en-GB')).toBe('2025')
  })
})
