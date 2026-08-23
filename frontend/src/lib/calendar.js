// Calendar ranges for the Home strip, which can show a week, a month or a year and step
// through them.
//
// Pure date arithmetic, kept out of the view because this is where calendars go wrong and
// the failures are seasonal: a month grid that breaks in a leap February, a week that
// starts on Sunday for half the year because of a DST hour, a "this year" that ends on
// 31 December but starts on 2 January. All of it is easy to test and impossible to notice
// by clicking around in August.
//
// Every date is built at NOON, not midnight. Adding days to a midnight Date across a DST
// boundary can land on 23:00 the previous day, which silently shifts the whole grid by one.
import { isoOf, DAYS, MONTHS, MONTHS_LONG } from './format.js'

export const PERIODS = ['week', 'month', 'year']

const noon = (y, m, d) => new Date(y, m, d, 12, 0, 0, 0)
const atNoon = date => noon(date.getFullYear(), date.getMonth(), date.getDate())

/** Monday of the week `offset` weeks from the one containing `from`. */
export function mondayOf(from, offset = 0) {
  const d = atNoon(from)
  // getDay() is 0=Sunday; the app's weeks start on Monday, so Sunday is 6 days in.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7)
  return d
}

/** The seven ISO dates of that week, Monday first. */
export function weekDays(from, offset = 0) {
  const monday = mondayOf(from, offset)
  return Array.from({ length: 7 }, (_, i) => {
    const d = noon(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
    return { iso: isoOf(d), day: d.getDate(), dow: d.getDay() }
  })
}

/**
 * A month as whole Monday-started weeks, so the grid is rectangular. Days spilling in from
 * the neighbouring months are included and flagged `out` — dropping them would misalign the
 * columns, and blanking them makes the first and last rows read as missing data.
 */
export function monthGrid(from, offset = 0) {
  const base = atNoon(from)
  const first = noon(base.getFullYear(), base.getMonth() + offset, 1)
  const year = first.getFullYear(), month = first.getMonth()
  const start = mondayOf(first)
  // Six rows is the worst case (a 31-day month starting on Sunday); February starting on a
  // Monday needs exactly four. Stop at the end of the first week that reaches the last day
  // of the month, rather than always drawing six — a trailing row of greyed-out next-month
  // days is noise, and the strip is the tallest thing on the Home screen.
  const lastDay = noon(year, month + 1, 0)
  const days = []
  for (let i = 0; i < 42; i++) {
    const d = noon(start.getFullYear(), start.getMonth(), start.getDate() + i)
    days.push({ iso: isoOf(d), day: d.getDate(), out: d.getMonth() !== month })
    if (i % 7 === 6 && d >= lastDay) break
  }
  return { year, month, days }
}

/** The twelve months of that year, each with the ISO range it covers. */
export function yearMonths(from, offset = 0) {
  const year = atNoon(from).getFullYear() + offset
  return Array.from({ length: 12 }, (_, m) => {
    const first = noon(year, m, 1)
    const last = noon(year, m + 1, 0)          // day 0 of next month = last day of this one
    return { year, month: m, from: isoOf(first), to: isoOf(last), days: last.getDate() }
  })
}

/**
 * What to show above the arrows. `offset === 0` is named rather than dated ("This week"),
 * because that is the one a reader has to recognise instantly. `t` is passed in so this
 * stays free of the i18n module, and `locale` picks the month names.
 */
export function periodLabel(period, from, offset, t, locale) {
  if (period === 'week') {
    if (offset === 0) return t('This week')
    const d = weekDays(from, offset)
    const mon = new Date(d[0].iso + 'T12:00:00')
    const sun = new Date(d[6].iso + 'T12:00:00')
    const name = x => x.toLocaleDateString(locale, { month: 'short' })
    return `${mon.getDate()} ${name(mon)} – ${sun.getDate()} ${name(sun)}`
  }
  if (period === 'month') {
    if (offset === 0) return t('This month')
    const { year, month } = monthGrid(from, offset)
    const label = t(MONTHS_LONG[month])
    // The year only earns its place once it is not the current one.
    return year === atNoon(from).getFullYear() ? label : `${label} ${year}`
  }
  if (offset === 0) return t('This year')
  return String(atNoon(from).getFullYear() + offset)
}

export { DAYS, MONTHS }
